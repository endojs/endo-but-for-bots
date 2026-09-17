#!/usr/bin/env python3
"""Measure the fixed object-capability corpus on parent, candidate, and XS."""

import argparse
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import random
import shutil
import statistics
import subprocess
import sys
import tempfile


CORPUS_ROOT = Path(__file__).resolve().parent
ENGINE_ROOT = CORPUS_ROOT.parents[1]
REPOSITORY_ROOT = ENGINE_ROOT.parents[1]
MANIFEST = CORPUS_ROOT / "manifest.json"
ROSTER = (
    "closure-site",
    "facet-cohort",
    "harden-tree",
    "harden-repeat",
    "ocap-mixed",
    "mutable-control",
)
SIZES = ("small", "representative", "stress")
PHASES = ("setup", "compile", "link", "execution", "collection", "checkpoint")
SAMPLE_PREFIX = "OCAP_SAMPLE "


def fixture_digest(corpus_root=CORPUS_ROOT):
    """Digest generated JavaScript source names and bytes in manifest order."""
    manifest = json.loads((corpus_root / "manifest.json").read_text())
    digest = hashlib.sha256()
    for fixture in sorted(manifest["fixtures"], key=lambda item: item["source"]):
        relative = fixture["source"].encode()
        payload = (corpus_root / fixture["source"]).read_bytes()
        digest.update(len(relative).to_bytes(8, "big"))
        digest.update(relative)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return digest.hexdigest()


def expected_keys(manifest):
    return [(fixture["name"], fixture["size"]) for fixture in manifest["fixtures"]]


def parse_samples(output, manifest):
    samples = {}
    for line in output.splitlines():
        if not line.startswith(SAMPLE_PREFIX):
            continue
        sample = json.loads(line[len(SAMPLE_PREFIX) :])
        key = (sample.get("fixture"), sample.get("size"))
        if key in samples:
            raise ValueError(f"duplicate sample {key}")
        samples[key] = sample
    expected = set(expected_keys(manifest))
    if set(samples) != expected:
        raise ValueError(
            f"sample roster differs: missing={sorted(expected - set(samples))}, "
            f"unexpected={sorted(set(samples) - expected)}"
        )
    return samples


def positive_number(value, label):
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ):
        raise ValueError(f"{label} must be a positive finite number")


def validate_sample(sample, engine, expected):
    if sample.get("engine") != engine:
        raise ValueError(f"expected {engine} sample")
    if sample.get("result") != expected:
        raise ValueError(f"observable result differs for {sample.get('fixture')}/{sample.get('size')}")
    positive_number(sample.get("computrons"), "computrons")
    positive_number(sample.get("meter_raw"), "meter_raw")
    phases = sample.get("phases_ns")
    if not isinstance(phases, dict) or set(phases) != set(PHASES):
        raise ValueError("phase roster differs")
    for phase in PHASES:
        value = phases[phase]
        if engine == "xs" and phase in ("setup", "link", "collection", "checkpoint"):
            if value is not None:
                raise ValueError(f"XS {phase} must be null")
        else:
            positive_number(value, f"{engine} {phase}")
    allocations = sample.get("allocations")
    if engine == "xs":
        if allocations is not None:
            raise ValueError("XS allocations must be null")
    elif not isinstance(allocations, dict) or any(
        isinstance(value, bool) or not isinstance(value, int) or value < 0
        for value in allocations.values()
    ):
        raise ValueError("Ironhorse allocations must be nonnegative integers")


def percentile(sorted_values, probability):
    index = min(len(sorted_values) - 1, int(probability * len(sorted_values)))
    return sorted_values[index]


def ratio_summary(parent, candidate, seed):
    parent_median = statistics.median(parent)
    candidate_median = statistics.median(candidate)
    ratio = candidate_median / parent_median
    generator = random.Random(seed)
    ratios = []
    for _ in range(10_000):
        parent_draw = [generator.choice(parent) for _ in parent]
        candidate_draw = [generator.choice(candidate) for _ in candidate]
        ratios.append(statistics.median(candidate_draw) / statistics.median(parent_draw))
    ratios.sort()
    return {
        "candidate_parent_ratio": ratio,
        "improvement_fraction": 1 - ratio,
        "bootstrap_95_ratio_interval": [
            percentile(ratios, 0.025),
            percentile(ratios, 0.975),
        ],
        "bootstrap_resamples": 10_000,
    }


def git_output(arguments, cwd=REPOSITORY_ROOT):
    return subprocess.check_output(["git", *arguments], cwd=cwd, text=True).strip()


def resolve_revision(revision):
    for candidate in (revision, f"origin/{revision}", f"ebfb/{revision}"):
        result = subprocess.run(
            ["git", "rev-parse", "--verify", f"{candidate}^{{commit}}"],
            cwd=REPOSITORY_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    raise ValueError(f"cannot resolve revision {revision}")


def build_driver(source_root, target_directory, environment):
    command = [
        "cargo",
        "test",
        "--manifest-path",
        str(source_root / "rust/engine/Cargo.toml"),
        "--locked",
        "--release",
        "-p",
        "ironhorse-262",
        "--test",
        "ocap_workload",
        "--no-run",
        "--message-format=json-render-diagnostics",
    ]
    build_environment = environment.copy()
    build_environment["CARGO_TARGET_DIR"] = str(target_directory)
    result = subprocess.run(
        command,
        cwd=source_root,
        env=build_environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        print(result.stdout, file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        raise RuntimeError(f"benchmark driver build failed in {source_root}")
    executable = None
    for line in result.stdout.splitlines():
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            message.get("reason") == "compiler-artifact"
            and message.get("target", {}).get("name") == "ocap_workload"
            and message.get("executable")
        ):
            executable = Path(message["executable"])
    if executable is None:
        raise RuntimeError("cargo did not report the benchmark driver executable")
    return executable, command


def prepare_parent(revision, destination):
    archive = subprocess.check_output(["git", "archive", revision], cwd=REPOSITORY_ROOT)
    subprocess.run(["tar", "-xf", "-", "-C", str(destination)], input=archive, check=True)
    overlays = (
        "rust/engine/Cargo.lock",
        "rust/engine/ironhorse-262/Cargo.toml",
        "rust/engine/ironhorse-262/tests/ocap_workload.rs",
    )
    for relative in overlays:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPOSITORY_ROOT / relative, target)
    shutil.copytree(CORPUS_ROOT, destination / "rust/engine/benches/ocap", dirs_exist_ok=True)
    moddable = destination / "c/moddable"
    if moddable.exists() or moddable.is_symlink():
        if moddable.is_dir() and not moddable.is_symlink():
            shutil.rmtree(moddable)
        else:
            moddable.unlink()
    current_moddable = REPOSITORY_ROOT / "c/moddable"
    if not (current_moddable / "xs/sources/xsAll.c").exists():
        raise RuntimeError("initialize c/moddable before running the object-capability benchmark")
    moddable.parent.mkdir(parents=True, exist_ok=True)
    moddable.symlink_to(current_moddable, target_is_directory=True)


def run_driver(executable, engine, environment, manifest):
    run_environment = environment.copy()
    run_environment["OCAP_ONLY_ENGINE"] = engine
    result = subprocess.run(
        [str(executable), "--ignored", "--nocapture", "--test-threads=1"],
        cwd=executable.parent,
        env=run_environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if result.returncode:
        print(result.stdout, file=sys.stderr)
        raise RuntimeError(f"{engine} benchmark driver exited {result.returncode}")
    return parse_samples(result.stdout, manifest)


def summarize(manifest, retained, digest):
    measurements = []
    for fixture_index, fixture in enumerate(manifest["fixtures"]):
        key = (fixture["name"], fixture["size"])
        arms = {}
        for arm in ("parent", "candidate", "xs"):
            samples = retained[arm][key]
            phases = {}
            for phase in PHASES:
                values = [sample["phases_ns"][phase] for sample in samples]
                phases[phase] = {
                    "samples_ns": values,
                    "median_ns": None if values[0] is None else statistics.median(values),
                }
            arms[arm] = {
                "result": samples[0]["result"],
                "computrons": samples[0]["computrons"],
                "meter_raw": samples[0]["meter_raw"],
                "dispatched": samples[0]["dispatched"],
                "allocations": samples[0]["allocations"],
                "phases": phases,
            }
        ratio = ratio_summary(
            arms["parent"]["phases"]["execution"]["samples_ns"],
            arms["candidate"]["phases"]["execution"]["samples_ns"],
            int(digest[:16], 16) + fixture_index,
        )
        measurements.append(
            {
                "fixture": fixture["name"],
                "size": fixture["size"],
                "source": fixture["source"],
                "expected": fixture["expected"],
                "arms": arms,
                "execution_comparison": ratio,
            }
        )
    representative = [
        measurement["execution_comparison"]["candidate_parent_ratio"]
        for measurement in measurements
        if measurement["size"] == "representative"
        and measurement["fixture"] != "mutable-control"
    ]
    composite = math.exp(sum(math.log(value) for value in representative) / len(representative))
    return measurements, composite


def validate_report(report):
    if report.get("schema_version") != 1:
        raise ValueError("schema_version must be 1")
    provenance = report.get("provenance")
    required_provenance = {
        "parent_commit",
        "candidate_commit",
        "xs_commit",
        "rustc",
        "cargo",
        "platform",
        "machine",
        "cpu",
        "hostname",
        "build_environment",
    }
    if not isinstance(provenance, dict) or not required_provenance <= set(provenance):
        raise ValueError("incomplete provenance")
    corpus = report.get("corpus")
    if not isinstance(corpus, dict) or not isinstance(corpus.get("fixture_sha256"), str):
        raise ValueError("missing fixture digest")
    if corpus.get("roster") != list(ROSTER) or corpus.get("sizes") != list(SIZES):
        raise ValueError("corpus roster differs")
    measurements = report.get("measurements")
    expected = {(name, size) for name in ROSTER for size in SIZES}
    if not isinstance(measurements, list):
        raise ValueError("measurements must be an array")
    actual = {(item.get("fixture"), item.get("size")) for item in measurements}
    if len(measurements) != 18 or actual != expected:
        raise ValueError("measurement roster differs")
    samples = report.get("methodology", {}).get("samples")
    warmups = report.get("methodology", {}).get("warmups")
    if not isinstance(samples, int) or samples < 7 or warmups != 1:
        raise ValueError("methodology requires one warmup and at least seven samples")
    for measurement in measurements:
        expected_result = measurement.get("expected")
        arms = measurement.get("arms", {})
        if set(arms) != {"parent", "candidate", "xs"}:
            raise ValueError("measurement arm roster differs")
        for arm_name, arm in arms.items():
            if arm.get("result") != expected_result:
                raise ValueError("report contains an unchecked observable result")
            phases = arm.get("phases", {})
            if set(phases) != set(PHASES):
                raise ValueError("report phase roster differs")
            for phase, summary in phases.items():
                values = summary.get("samples_ns")
                if not isinstance(values, list) or len(values) != samples:
                    raise ValueError("report sample count differs")
                if arm_name == "xs" and phase in ("setup", "link", "collection", "checkpoint"):
                    if any(value is not None for value in values) or summary.get("median_ns") is not None:
                        raise ValueError("unavailable XS phase must remain null")
                else:
                    for value in values:
                        positive_number(value, f"{arm_name} {phase}")
                    positive_number(summary.get("median_ns"), f"{arm_name} {phase} median")
            if arm_name == "xs":
                if arm.get("allocations") is not None:
                    raise ValueError("XS allocations must remain null")
            elif not isinstance(arm.get("allocations"), dict):
                raise ValueError("Ironhorse allocation counters are required")
        if arms["parent"]["result"] != arms["candidate"]["result"]:
            raise ValueError("parent and candidate observable results differ")
        if arms["parent"]["computrons"] != arms["candidate"]["computrons"]:
            raise ValueError("parent and candidate computrons differ")
    failures = report.get("validation", {}).get("failures")
    if not isinstance(failures, list):
        raise ValueError("validation failures must be an array")
    return True


def cpu_name():
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.lower().startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or "unknown"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parent", default="HEAD^", help="parent engine revision")
    parser.add_argument("--candidate", default="HEAD", help="candidate engine revision")
    parser.add_argument("--samples", type=int, default=7)
    parser.add_argument("--warmups", type=int, default=1)
    parser.add_argument("--output", type=Path, default=ENGINE_ROOT / "benches/results/ocap-initial.json")
    parser.add_argument("--validate", type=Path, help="validate a report without measuring")
    args = parser.parse_args()
    if args.validate:
        validate_report(json.loads(args.validate.read_text()))
        print(f"valid object-capability report: {args.validate}")
        return 0
    if args.samples < 7 or args.warmups != 1:
        parser.error("measurement requires one warmup and at least seven samples")

    manifest = json.loads(MANIFEST.read_text())
    if [fixture["name"] for fixture in manifest["fixtures"]] != [
        name for name in ROSTER for _ in SIZES
    ] or [fixture["size"] for fixture in manifest["fixtures"]] != list(SIZES) * len(ROSTER):
        raise ValueError("manifest must contain the fixed six-by-three roster")

    generation_started = datetime.datetime.now(datetime.timezone.utc)
    generation = subprocess.run(
        [sys.executable, str(CORPUS_ROOT / "generate.py"), "--check", "--digest"],
        cwd=REPOSITORY_ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    generation_elapsed_ns = int(
        (datetime.datetime.now(datetime.timezone.utc) - generation_started).total_seconds() * 1e9
    )
    if generation.returncode:
        raise RuntimeError(generation.stderr.strip())
    digest = fixture_digest()
    if generation.stdout.strip() != digest:
        raise ValueError("generator and runner fixture digests differ")

    parent_commit = resolve_revision(args.parent)
    candidate_commit = resolve_revision(args.candidate)
    xs_commit = git_output(["-C", "c/moddable", "rev-parse", "HEAD"])
    environment = os.environ.copy()
    environment["CARGO_INCREMENTAL"] = "0"
    environment["RUST_MIN_STACK"] = "33554432"
    retained = {arm: {key: [] for key in expected_keys(manifest)} for arm in ("parent", "candidate", "xs")}
    sample_order = []
    failures = []
    with tempfile.TemporaryDirectory(prefix="ironhorse-ocap-") as temporary:
        temporary_root = Path(temporary)
        parent_root = temporary_root / "parent"
        parent_root.mkdir()
        prepare_parent(parent_commit, parent_root)
        parent_executable, parent_build = build_driver(parent_root, temporary_root / "target-parent", environment)
        candidate_executable, candidate_build = build_driver(
            REPOSITORY_ROOT, temporary_root / "target-candidate", environment
        )
        total_rounds = args.warmups + args.samples
        for round_index in range(total_rounds):
            order = ("parent", "candidate") if round_index % 2 == 0 else ("candidate", "parent")
            sample_order.append(
                {"round": round_index, "warmup": round_index < args.warmups, "ironhorse_order": list(order), "xs_after": True}
            )
            for arm in order:
                executable = parent_executable if arm == "parent" else candidate_executable
                observed = run_driver(executable, "ironhorse", environment, manifest)
                for fixture in manifest["fixtures"]:
                    key = (fixture["name"], fixture["size"])
                    sample = observed[key]
                    validate_sample(sample, "ironhorse", fixture["expected"])
                    if round_index >= args.warmups:
                        retained[arm][key].append(sample)
            observed = run_driver(candidate_executable, "xs", environment, manifest)
            for fixture in manifest["fixtures"]:
                key = (fixture["name"], fixture["size"])
                sample = observed[key]
                validate_sample(sample, "xs", fixture["expected"])
                if round_index >= args.warmups:
                    retained["xs"][key].append(sample)

        for fixture in manifest["fixtures"]:
            key = (fixture["name"], fixture["size"])
            parent = retained["parent"][key]
            candidate = retained["candidate"][key]
            xs = retained["xs"][key]
            stable_fields = ("result", "computrons", "meter_raw", "dispatched", "allocations")
            for arm_name, samples_for_arm in (("parent", parent), ("candidate", candidate), ("xs", xs)):
                for field in stable_fields:
                    values = [sample[field] for sample in samples_for_arm]
                    if any(value != values[0] for value in values[1:]):
                        failures.append(f"{fixture['name']}/{fixture['size']} {arm_name} {field} is nondeterministic")
            for field in stable_fields:
                if parent[0][field] != candidate[0][field]:
                    failures.append(f"{fixture['name']}/{fixture['size']} parent/candidate {field} differs")
            if candidate[0]["result"] != xs[0]["result"]:
                failures.append(f"{fixture['name']}/{fixture['size']} Ironhorse/XS result differs")

        measurements, composite = summarize(manifest, retained, digest)
        rustc = subprocess.check_output(["rustc", "--version"], cwd=ENGINE_ROOT, env=environment, text=True).strip()
        cargo = subprocess.check_output(["cargo", "--version"], cwd=ENGINE_ROOT, env=environment, text=True).strip()
        report = {
            "schema_version": 1,
            "generated_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
            "command": [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]],
            "provenance": {
                "parent_commit": parent_commit,
                "candidate_commit": candidate_commit,
                "xs_commit": xs_commit,
                "rustc": rustc,
                "cargo": cargo,
                "platform": platform.platform(),
                "machine": platform.machine(),
                "cpu": cpu_name(),
                "hostname": platform.node(),
                "build_environment": {
                    name: environment.get(name)
                    for name in (
                        "CC",
                        "CFLAGS",
                        "RUSTFLAGS",
                        "CARGO_ENCODED_RUSTFLAGS",
                        "CARGO_INCREMENTAL",
                        "RUST_MIN_STACK",
                        "RUSTUP_TOOLCHAIN",
                        "CARGO_BUILD_TARGET",
                    )
                },
                "parent_build_command": parent_build,
                "candidate_build_command": candidate_build,
            },
            "corpus": {
                "fixture_sha256": digest,
                "roster": list(ROSTER),
                "sizes": list(SIZES),
                "source_generation_ns": generation_elapsed_ns,
            },
            "methodology": {
                "profile": "release",
                "serial": True,
                "warmups": args.warmups,
                "samples": args.samples,
                "sample_order": sample_order,
                "primary_phase": "execution",
                "object_capability_composite": "representative size geometric mean excluding mutable-control",
            },
            "measurements": measurements,
            "summary": {
                "representative_candidate_parent_geometric_mean": composite,
                "representative_improvement_fraction": 1 - composite,
            },
            "validation": {
                "observable_results_checked": True,
                "parent_candidate_computrons_identical": not any("computrons differs" in failure for failure in failures),
                "parent_candidate_allocations_identical": not any("allocations differs" in failure for failure in failures),
                "failures": failures,
            },
        }
        validate_report(report)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    for failure in failures:
        print(f"FAIL: {failure}", file=sys.stderr)
    print(f"object-capability report: {args.output}")
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())
