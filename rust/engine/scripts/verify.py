#!/usr/bin/env python3
"""Run, audit and ledger the Ironhorse Kani proofs (rust/engine/VERIFICATION.md).

Subcommands:
  check                 manifest well-formed; harnesses in the tree == manifest;
                        mutant patches apply; ledger up to date. No solving.
  run --tier T          run harnesses (batched per crate and flag set) and
                        enforce the soundness rules; exit 1 on any violation.
  ledger [--check]      regenerate (or verify) the generated VERIFICATION.md table.
  mutants [--id P]      apply each mutant to a scratch copy and require that a
                        referencing harness fails with a counterexample.
  selftest              run the deliberately bad harnesses in
                        verification/selftest and require each verdict.

Results are read from Kani's `--export-json` (per-check statuses with the
function each check lives in), which is the only format that carries cover
and unreachable statuses per check; SARIF lists failures only. The regular
text output is cross-checked for each harness's overall verdict.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import re
import resource
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
import zlib
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
MANIFEST = ENGINE / "verification" / "proofs.toml"
MUTANTS = ENGINE / "verification" / "mutants"
LEDGER = ENGINE / "VERIFICATION.md"
SELFTEST = ENGINE / "verification" / "selftest"
LOGS = ENGINE / "target" / "kani" / "verify-logs"
MUTANT_TREE = ENGINE / "target" / "verify-mutants" / "tree"
# Mutant builds get their own target directory. Cargo hashes a workspace
# member by its path relative to the workspace root, so a copy of the tree
# built into the main target directory would overwrite the real artifacts,
# and a later real run could reuse mutated code that looks fresh.
MUTANT_TARGET = ENGINE / "target" / "verify-mutants" / "target"
BEGIN = "<!-- BEGIN GENERATED: scripts/verify.py ledger -->"
END = "<!-- END GENERATED: scripts/verify.py ledger -->"

GUARANTEE_ID = re.compile(r"^[A-Z]+-[0-9]+[a-z]?$")
MUTANT_NAME = re.compile(r"^[A-Z]+-[0-9]+[a-z]?-[a-z0-9]+$")
TIERS = ("pr", "nightly")
EXPECTS = ("pass", "fail")
HARNESS_KEYS = {
    "guarantee": str, "crate": str, "name": str, "tier": str, "statement": str,
    "domain": str, "unwind": int, "flags": list, "time_budget_s": (int, float),
    "memory_budget_gb": (int, float), "unreachable": int, "mutants": list,
    "expect": str, "canary": bool,
}
HARNESS_OPTIONAL = {"spec": str, "flags_reason": str, "unreachable_reason": str}
GUARANTEE_KEYS = {"id": str, "title": str, "claim": str, "spec": str, "trusted": list}
CHECK_STATUSES = {"Success", "Failure", "Satisfied", "Unsatisfiable", "Unreachable",
                  "Undetermined"}
FAIL_BUDGET = 2.0
WARN_BUDGET = 1.5


class ManifestError(Exception):
    pass


# ---- manifest ---------------------------------------------------------------

def load_manifest(path: Path = MANIFEST) -> dict:
    """Load `proofs.toml` and merge every `proofs.d/*.toml` beside it.

    The fragments hold further `[[guarantee]]` and `[[harness]]` tables, one
    file per area, so unrelated proof work does not contend for one file.
    Top-level scalars live in `proofs.toml` only.
    """
    data = tomllib.loads(path.read_text())
    for fragment in sorted((path.parent / "proofs.d").glob("*.toml")):
        extra = tomllib.loads(fragment.read_text())
        unknown = set(extra) - {"guarantee", "harness"}
        if unknown:
            raise ManifestError(
                f"{fragment.name}: only [[guarantee]] and [[harness]] tables may "
                f"appear in a fragment, found {sorted(unknown)}")
        for key in ("guarantee", "harness"):
            data.setdefault(key, []).extend(extra.get(key, []))
    return data


def validate_manifest(data: dict, mutant_names: set[str] | None = None) -> list[str]:
    """Return a list of problems; empty means well-formed."""
    errors: list[str] = []
    if not isinstance(data.get("kani_version"), str):
        errors.append("top-level kani_version (string) is required")
    guarantees = {}
    for g in data.get("guarantee", []):
        for key, kind in GUARANTEE_KEYS.items():
            if not isinstance(g.get(key), kind):
                errors.append(f"guarantee {g.get('id')!r}: {key} must be {kind}")
        extra = set(g) - set(GUARANTEE_KEYS)
        if extra:
            errors.append(f"guarantee {g.get('id')!r}: unknown keys {sorted(extra)}")
        gid = g.get("id", "")
        if not GUARANTEE_ID.match(str(gid)):
            errors.append(f"guarantee id {gid!r} is not like MTR-1")
        if gid in guarantees:
            errors.append(f"guarantee {gid} defined twice")
        guarantees[gid] = g
    seen: set[tuple[str, str]] = set()
    referenced: set[str] = set()
    by_guarantee: dict[str, list[dict]] = {}
    for h in data.get("harness", []):
        label = f"harness {h.get('crate')}::{h.get('name')}"
        for key, kind in HARNESS_KEYS.items():
            if key not in h:
                errors.append(f"{label}: missing {key}")
            elif not isinstance(h[key], kind) or (kind is int and isinstance(h[key], bool)):
                errors.append(f"{label}: {key} must be {kind}")
        for key, kind in HARNESS_OPTIONAL.items():
            if key in h and not isinstance(h[key], kind):
                errors.append(f"{label}: {key} must be {kind}")
        extra = set(h) - set(HARNESS_KEYS) - set(HARNESS_OPTIONAL)
        if extra:
            errors.append(f"{label}: unknown keys {sorted(extra)}")
        if h.get("tier") not in TIERS:
            errors.append(f"{label}: tier must be one of {TIERS}")
        if h.get("expect") not in EXPECTS:
            errors.append(f"{label}: expect must be one of {EXPECTS}")
        if h.get("guarantee") not in guarantees:
            errors.append(f"{label}: unknown guarantee {h.get('guarantee')!r}")
        if h.get("flags") and not h.get("flags_reason"):
            errors.append(f"{label}: non-empty flags need flags_reason (R2)")
        if h.get("unreachable", 0) and not h.get("unreachable_reason"):
            errors.append(f"{label}: a pinned unreachable count needs unreachable_reason (R3)")
        if h.get("expect") == "fail" and not h.get("canary"):
            errors.append(f"{label}: only a canary may expect failure")
        for m in h.get("mutants", []):
            if not MUTANT_NAME.match(str(m)):
                errors.append(f"{label}: mutant name {m!r} is not like MTR-1-a")
            elif mutant_names is not None and m not in mutant_names:
                errors.append(f"{label}: mutant {m} has no verification/mutants/{m}.patch")
            referenced.add(m)
        key = (h.get("crate"), h.get("name"))
        if key in seen:
            errors.append(f"{label}: listed twice")
        seen.add(key)
        by_guarantee.setdefault(h.get("guarantee"), []).append(h)
    for gid, g in guarantees.items():
        harnesses = by_guarantee.get(gid, [])
        if not harnesses:
            errors.append(f"guarantee {gid}: no harness")
        if not all(h.get("canary") for h in harnesses):
            if not any(h.get("mutants") for h in harnesses):
                errors.append(f"guarantee {gid}: no mutant (R4)")
    if mutant_names is not None:
        for m in sorted(mutant_names - referenced):
            errors.append(f"mutant {m}.patch is referenced by no harness")
    return errors


def mutant_files() -> set[str]:
    return {p.stem for p in MUTANTS.glob("*.patch")} if MUTANTS.exists() else set()


# ---- Kani output parsing ----------------------------------------------------

@dataclasses.dataclass
class Verdict:
    name: str
    result: str = "error"         # "pass", "fail" or "error"
    seconds: float | None = None
    violations: list[str] = dataclasses.field(default_factory=list)
    covers: tuple[int, int] = (0, 0)  # satisfied, total
    library_unreachable: int = 0
    note: str = ""


def is_harness_code(function: str, harness: str) -> bool:
    """A check is written in the harness itself if it lives in the harness
    function or one of its closures. Checks in shared proof helpers and in
    library code count toward the pinned `unreachable` number instead."""
    return function == harness or function.startswith(harness + "::")


def parse_regular(text: str) -> dict[str, str]:
    """Map harness name -> SUCCESSFUL/FAILED from Kani's regular output."""
    verdicts: dict[str, str] = {}
    current = None
    for line in text.splitlines():
        m = re.match(r"Checking harness (\S+)\.\.\.$", line.strip())
        if m:
            current = m.group(1)
            continue
        m = re.match(r"VERIFICATION:- (SUCCESSFUL|FAILED)", line.strip())
        if m and current is not None:
            verdicts[current] = m.group(1)
            current = None
    return verdicts


def judge(harness: dict, export: dict | None, regular: dict[str, str]) -> Verdict:
    """Apply the soundness rules to one harness's Kani results."""
    name = harness["name"]
    v = Verdict(name)
    if export is None:
        v.violations.append("no --export-json result (driver crash or compile error)")
        return v
    results = {r.get("harness_id"): r for r in
               export.get("verification_results", {}).get("results", [])}
    errors = {e.get("harness_id"): e for e in export.get("error_details", [])}
    result = results.get(name)
    if result is None:
        v.violations.append("missing per-harness result")
        return v
    if "duration_ms" in result:
        v.seconds = result["duration_ms"] / 1000
    error = errors.get(name, {})
    exit_status = error.get("exit_status")
    if error.get("has_errors") and exit_status != "properties_failed":
        v.violations.append(f"solver/resource error: {exit_status} ({error.get('error_type')})")
        return v
    checks = result.get("checks", [])
    if not checks:
        v.violations.append("no checks reported (solver error)")
        return v
    unknown = {c.get("status") for c in checks} - CHECK_STATUSES
    if unknown:
        v.violations.append(f"unknown check statuses {sorted(unknown)}")
        return v
    covers = [c for c in checks if c.get("category") == "cover"
              or c.get("status") in ("Satisfied", "Unsatisfiable")]
    own_unreachable = [c for c in checks if c["status"] == "Unreachable"
                       and is_harness_code(c.get("function", ""), name)]
    lib_unreachable = [c for c in checks if c["status"] == "Unreachable"
                       and not is_harness_code(c.get("function", ""), name)]
    v.library_unreachable = len(lib_unreachable)
    satisfied = sum(c["status"] == "Satisfied" for c in covers)
    v.covers = (satisfied, len(covers))
    if any(c["status"] == "Undetermined" for c in checks):
        v.violations.append("undetermined checks (solver gave up)")
    if not covers:
        v.violations.append("no kani::cover! in the harness (R3 witness rule)")
    for c in covers:
        if c["status"] != "Satisfied":
            v.violations.append(f"cover not satisfied ({c['status']}): {c.get('description')}")
    for c in own_unreachable:
        if c not in covers:
            v.violations.append(f"harness check unreachable: {c.get('description')}")
    pinned = harness.get("unreachable", 0)
    if v.library_unreachable != pinned:
        v.violations.append(
            f"library unreachable count {v.library_unreachable}, manifest pins {pinned}")
    failed = [c for c in checks if c["status"] == "Failure"]
    v.result = "fail" if failed else "pass"
    if failed:
        v.note = "; ".join(sorted({str(c.get("description")) for c in failed}))[:200]
    status = result.get("status")
    if (status == "Success") != (not failed):
        v.violations.append(f"harness status {status} disagrees with its checks")
    text = regular.get(name)
    if text is None:
        v.violations.append("missing from the regular output")
    elif (text == "SUCCESSFUL") != (status == "Success"):
        v.violations.append(f"regular output says {text}, JSON says {status}")
    if v.result != harness["expect"]:
        v.violations.append(f"result {v.result}, manifest expects {harness['expect']}"
                            + (f" ({v.note})" if v.note else ""))
    if v.seconds is not None:
        budget = harness["time_budget_s"]
        if v.seconds > FAIL_BUDGET * budget:
            v.violations.append(f"{v.seconds:.1f}s exceeds {FAIL_BUDGET}x budget {budget}s")
        elif v.seconds > WARN_BUDGET * budget:
            v.note = (v.note + "; " if v.note else "") + f"warning: over {WARN_BUDGET}x budget"
    return v


# ---- running Kani -----------------------------------------------------------

def crate_dir(crate: str, root: Path = ENGINE) -> Path:
    path = root / crate
    if not (path / "Cargo.toml").exists():
        raise ManifestError(f"crate {crate} has no directory {path}")
    return path


def z_flags(flags: list[str]) -> list[str]:
    out = []
    for i, f in enumerate(flags):
        if f == "-Z" and i + 1 < len(flags):
            out += ["-Z", flags[i + 1]]
        elif f.startswith("-Z") and f != "-Z":
            out.append(f)
    return out


def limit_address_space(gb: float):
    def apply():
        cap = int(gb * 1024 ** 3)
        resource.setrlimit(resource.RLIMIT_AS, (cap, cap))
    return apply


# Runs cargo kani and records the peak RSS of its largest descendant (KiB),
# so each batch's memory is measured on its own.
RSS_WRAPPER = """
import resource, subprocess, sys
code = subprocess.run(sys.argv[2:]).returncode
with open(sys.argv[1], "w") as f:
    f.write(str(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss))
sys.exit(code)
"""


def batches(harnesses: list[dict]) -> list[tuple[str, tuple[str, ...], list[dict]]]:
    groups: dict[tuple[str, tuple[str, ...]], list[dict]] = {}
    for h in harnesses:
        groups.setdefault((h["crate"], tuple(h["flags"])), []).append(h)
    return [(c, f, hs) for (c, f), hs in sorted(groups.items())]


def kani_batch(crate: str, flags: tuple[str, ...], harnesses: list[dict], args,
               root: Path = ENGINE, tag: str = "") -> tuple[dict | None, str, int, float, float]:
    """Run one cargo kani invocation; returns (export, regular text, exit code,
    wall seconds, peak child RSS in GB)."""
    LOGS.mkdir(parents=True, exist_ok=True)
    stem = f"{tag}{crate}-{zlib.crc32(' '.join(flags).encode()):08x}"
    export_path = LOGS / f"{stem}.json"
    export_path.unlink(missing_ok=True)
    harness_timeout = max(FAIL_BUDGET * h["time_budget_s"] for h in harnesses)
    cmd = ["cargo", "kani", "--lib", "-Z", "unstable-options",
           "--export-json", str(export_path),
           "--harness-timeout", f"{int(harness_timeout) + 1}s", *flags]
    for h in harnesses:
        cmd += ["--harness", h["name"]]
    cmd.append("--exact")
    wall_cap = 600 + sum(FAIL_BUDGET * h["time_budget_s"] for h in harnesses)
    env = dict(os.environ)
    env.setdefault("CARGO_TARGET_DIR", str(ENGINE / "target"))
    rss_path = LOGS / f"{stem}.rss"
    rss_path.unlink(missing_ok=True)
    start = time.monotonic()
    proc = subprocess.Popen([sys.executable, "-c", RSS_WRAPPER, str(rss_path), *cmd],
                            cwd=crate_dir(crate, root), env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            start_new_session=True,
                            preexec_fn=limit_address_space(args.memory_cap_gb))
    try:
        text, _ = proc.communicate(timeout=wall_cap)
        code = proc.returncode
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, 9)
        text, _ = proc.communicate()
        code = -1
    wall = time.monotonic() - start
    try:
        peak_gb = int(rss_path.read_text()) / 1024 ** 2
    except (OSError, ValueError):
        peak_gb = 0.0
    (LOGS / f"{stem}.log").write_text(" ".join(cmd) + "\n\n" + text)
    export = None
    if export_path.exists():
        try:
            export = json.loads(export_path.read_text())
        except json.JSONDecodeError:
            export = None
    return export, text, code, wall, peak_gb


def run_harnesses(harnesses: list[dict], args, root: Path = ENGINE, tag: str = ""):
    verdicts: list[tuple[dict, Verdict]] = []
    total_wall = 0.0
    for crate, flags, group in batches(harnesses):
        print(f"== {crate} {' '.join(flags) or '(default checks)'}: "
              f"{len(group)} harness(es)", flush=True)
        export, text, code, wall, peak_gb = kani_batch(crate, flags, group, args, root, tag)
        total_wall += wall
        regular = parse_regular(text)
        memory_budget = max(h["memory_budget_gb"] for h in group)
        for h in group:
            v = judge(h, export, regular)
            if code not in (0, 1):
                v.violations.append(f"cargo kani exited {code} (101: compile error; -1: wall timeout)")
            if peak_gb > FAIL_BUDGET * memory_budget:
                v.violations.append(f"batch peak RSS {peak_gb:.1f} GB exceeds "
                                    f"{FAIL_BUDGET}x budget {memory_budget} GB")
            verdicts.append((h, v))
        print(f"   {wall:.1f}s wall, peak child RSS {peak_gb:.2f} GB, exit {code}", flush=True)
    return verdicts, total_wall


def print_table(verdicts: list[tuple[dict, Verdict]]):
    rows = [("ID", "harness", "tier", "result", "time", "budget", "covers", "lib-unr", "status")]
    for h, v in verdicts:
        rows.append((h["guarantee"], f"{h['crate']}::{h['name']}", h["tier"], v.result,
                     "-" if v.seconds is None else f"{v.seconds:.2f}s",
                     f"{h['time_budget_s']}s", f"{v.covers[0]}/{v.covers[1]}",
                     str(v.library_unreachable),
                     "OK" if not v.violations else "VIOLATION"))
    widths = [max(len(r[i]) for r in rows) for i in range(len(rows[0]))]
    for r in rows:
        print("  ".join(c.ljust(w) for c, w in zip(r, widths)))
    for h, v in verdicts:
        for msg in v.violations:
            print(f"VIOLATION {h['guarantee']} {h['crate']}::{h['name']}: {msg}")
        if v.note and "warning" in v.note:
            print(f"WARNING {h['guarantee']} {h['crate']}::{h['name']}: {v.note}")


def select(data: dict, tier: str, crate: str | None, prefix: str | None) -> list[dict]:
    out = []
    for h in data.get("harness", []):
        if tier != "all" and h["tier"] != tier:
            continue
        if crate and h["crate"] != crate:
            continue
        if prefix and not h["guarantee"].startswith(prefix):
            continue
        out.append(h)
    return out


def kani_version() -> str:
    out = subprocess.run(["cargo", "kani", "--version"], text=True,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout
    m = re.search(r"Kani Rust Verifier (\S+)", out)
    return m.group(1) if m else "unknown"


def cmd_run(args) -> int:
    data = load_manifest()
    errors = validate_manifest(data, mutant_files())
    if errors:
        print("\n".join(errors))
        return 1
    version = kani_version()
    if version != data["kani_version"]:
        print(f"Kani {version} installed, manifest pins {data['kani_version']}: "
              "upgrades are a deliberate PR (VERIFICATION.md)")
        return 1
    harnesses = select(data, args.tier, args.crate, args.id)
    if not harnesses:
        print("no harness selected")
        return 1
    start = time.monotonic()
    verdicts, _ = run_harnesses(harnesses, args)
    print_table(verdicts)
    bad = sum(bool(v.violations) for _, v in verdicts)
    print(f"{len(verdicts) - bad} of {len(verdicts)} harnesses OK in "
          f"{time.monotonic() - start:.1f}s wall")
    return 1 if bad else 0


# ---- check ------------------------------------------------------------------

def source_harnesses(root: Path = ENGINE) -> dict[str, int]:
    """Count `#[kani::proof]` per workspace member, by grepping sources."""
    members = tomllib.loads((root / "Cargo.toml").read_text())["workspace"]["members"]
    counts = {}
    for m in members:
        n = 0
        for path in (root / m / "src").rglob("*.rs"):
            n += len(re.findall(r"#\[kani::proof\]", path.read_text()))
        if n:
            counts[m] = n
    return counts


def kani_list(crate: str, flags: list[str], root: Path = ENGINE) -> set[str]:
    directory = crate_dir(crate, root)
    listing = directory / "kani-list.json"
    listing.unlink(missing_ok=True)
    env = dict(os.environ)
    env.setdefault("CARGO_TARGET_DIR", str(ENGINE / "target"))
    proc = subprocess.run(["cargo", "kani", "list", "--format", "json", *flags],
                          cwd=directory, env=env, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT)
    try:
        if proc.returncode != 0 or not listing.exists():
            raise ManifestError(f"cargo kani list failed in {crate}:\n{proc.stdout[-2000:]}")
        data = json.loads(listing.read_text())
    finally:
        listing.unlink(missing_ok=True)
    names = set()
    for group in ("standard-harnesses", "contract-harnesses"):
        for entries in data.get(group, {}).values():
            names.update(entries)
    return names


def unwind_attribute(crate: str, name: str, root: Path = ENGINE) -> int | None:
    """The `#[kani::unwind(N)]` on the harness's fn, 0 if none, None if not found."""
    fn = re.compile(r"^\s*fn\s+" + re.escape(name.rsplit("::", 1)[-1]) + r"\s*[(<]")
    for path in (root / crate / "src").rglob("*.rs"):
        text = path.read_text()
        if "kani::proof" not in text:
            continue
        lines = text.splitlines()
        for i, line in enumerate(lines):
            if not fn.match(line):
                continue
            attributes = []
            j = i - 1
            while j >= 0 and lines[j].strip().startswith(("#[", "///", "//")):
                attributes.append(lines[j])
                j -= 1
            block = "\n".join(attributes)
            if "kani::proof" in block:
                u = re.search(r"kani::unwind\((\d+)\)", block)
                return int(u.group(1)) if u else 0
    return None


def patch_applies(patch: Path, root: Path) -> tuple[bool, str]:
    proc = subprocess.run(["patch", "-p1", "--dry-run", "--batch", "--forward", "-s",
                           "-d", str(root), "-i", str(patch)],
                          text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return proc.returncode == 0, proc.stdout


def cmd_check(args) -> int:
    data = load_manifest()
    errors = validate_manifest(data, mutant_files())
    in_tree = source_harnesses()
    manifest_crates = {h["crate"] for h in data.get("harness", [])}
    for crate in sorted(set(in_tree) | manifest_crates):
        listed = {h["name"] for h in data["harness"] if h["crate"] == crate}
        flags = sorted({f for h in data["harness"] if h["crate"] == crate
                        for f in z_flags(h["flags"])})
        try:
            found = kani_list(crate, flags) if crate in in_tree else set()
        except ManifestError as e:
            errors.append(str(e))
            continue
        if len(found) != in_tree.get(crate, 0):
            errors.append(f"{crate}: cargo kani list found {len(found)} harnesses, "
                          f"sources have {in_tree.get(crate, 0)} #[kani::proof]")
        for name in sorted(found - listed):
            errors.append(f"{crate}::{name}: harness in the tree but not in the manifest")
        for name in sorted(listed - found):
            errors.append(f"{crate}::{name}: in the manifest but not in the tree (stale)")
        for h in data["harness"]:
            if h["crate"] == crate and h["name"] in found:
                unwind = unwind_attribute(crate, h["name"])
                if unwind is not None and unwind != h["unwind"]:
                    errors.append(f"{crate}::{h['name']}: #[kani::unwind({unwind})] "
                                  f"but manifest unwind = {h['unwind']}")
    for name in sorted(mutant_files()):
        ok, out = patch_applies(MUTANTS / f"{name}.patch", ENGINE)
        if not ok:
            errors.append(f"mutant {name}.patch no longer applies:\n{out}")
    if LEDGER.exists():
        actual = LEDGER.read_text()
        if splice(actual, render_ledger(data)) != actual:
            errors.append("VERIFICATION.md generated table is stale: run verify.py ledger")
    else:
        errors.append("VERIFICATION.md is missing")
    for e in errors:
        print(e)
    print("check: " + ("FAILED" if errors else
                       f"OK ({len(data.get('harness', []))} harnesses, "
                       f"{len(mutant_files())} mutants)"))
    return 1 if errors else 0


# ---- ledger -----------------------------------------------------------------

def cell(text: str) -> str:
    return " ".join(str(text).split()).replace("|", "\\|")


def render_ledger(data: dict) -> str:
    harnesses = data.get("harness", [])
    lines = [BEGIN, "",
             f"Generated from `verification/proofs.toml` by `scripts/verify.py ledger`; "
             f"do not edit by hand. Pinned Kani: {data.get('kani_version')}.", ""]
    lines += ["| ID | Guarantee | Claim | Spec | Trusted base | Harnesses | Mutants |",
              "|---|---|---|---|---|---|---|"]
    for g in data.get("guarantee", []):
        own = [h for h in harnesses if h["guarantee"] == g["id"]]
        tiers = sorted({h["tier"] for h in own})
        mutants = sorted({m for h in own for m in h["mutants"]})
        lines.append("| " + " | ".join([
            g["id"], cell(g["title"]), cell(g["claim"]), cell(g["spec"]),
            cell(", ".join(g["trusted"])), f"{len(own)} ({', '.join(tiers)})",
            ", ".join(f"`{m}`" for m in mutants) or "none (canary)"]) + " |")
    lines += ["", "| ID | Harness | Tier | Statement | Domain | Unwind | Flags | "
              "Budget | Lib. unreachable | Expect |",
              "|---|---|---|---|---|---|---|---|---|---|"]
    for h in harnesses:
        flags = " ".join(h["flags"]) or "default"
        lines.append("| " + " | ".join([
            h["guarantee"], f"`{h['crate']}` `{h['name']}`", h["tier"],
            cell(h["statement"]), cell(h["domain"]), str(h["unwind"]), cell(flags),
            f"{h['time_budget_s']} s / {h['memory_budget_gb']} GB",
            str(h["unreachable"]),
            h["expect"] + (" (canary)" if h["canary"] else "")]) + " |")
    lines += ["", END]
    return "\n".join(lines)


def splice(document: str, generated: str) -> str:
    if BEGIN not in document or END not in document:
        raise ManifestError("VERIFICATION.md lacks the generated-table markers")
    head, rest = document.split(BEGIN, 1)
    _, tail = rest.split(END, 1)
    return head + generated + tail


def cmd_ledger(args) -> int:
    data = load_manifest()
    errors = validate_manifest(data, mutant_files())
    if errors:
        print("\n".join(errors))
        return 1
    actual = LEDGER.read_text()
    expected = splice(actual, render_ledger(data))
    if args.check:
        if actual != expected:
            print("VERIFICATION.md generated table is stale: run scripts/verify.py ledger")
            return 1
        print("ledger: OK")
        return 0
    LEDGER.write_text(expected)
    return 0


# ---- mutants ----------------------------------------------------------------

def copy_tree(dest: Path):
    """A scratch copy of the engine workspace's member sources and manifests
    (no target directories), so a mutant never touches the working tree.
    Files are copied with fresh mtimes, so Cargo rebuilds every crate rather
    than reusing an artifact built from the previous mutant."""
    if dest.exists():
        shutil.rmtree(dest)
    dest.mkdir(parents=True)
    for name in ("Cargo.toml", "Cargo.lock", "rust-toolchain.toml"):
        if (ENGINE / name).exists():
            shutil.copy(ENGINE / name, dest / name)
    members = tomllib.loads((ENGINE / "Cargo.toml").read_text())["workspace"]["members"]
    ignore = shutil.ignore_patterns("target", "kani-list.json")
    for m in members:
        shutil.copytree(ENGINE / m, dest / m, ignore=ignore, symlinks=True,
                        copy_function=shutil.copy)


def cmd_mutants(args) -> int:
    data = load_manifest()
    errors = validate_manifest(data, mutant_files())
    if errors:
        print("\n".join(errors))
        return 1
    names = sorted({m for h in data["harness"] for m in h["mutants"]})
    if args.id:
        names = [n for n in names if n.startswith(args.id)]
    failures = []
    saved = os.environ.get("CARGO_TARGET_DIR")
    os.environ["CARGO_TARGET_DIR"] = str(MUTANT_TARGET)
    try:
        for name in names:
            harnesses = [h for h in data["harness"] if name in h["mutants"]]
            copy_tree(MUTANT_TREE)
            patch = MUTANTS / f"{name}.patch"
            ok, out = patch_applies(patch, MUTANT_TREE)
            if not ok:
                failures.append(f"{name}: patch does not apply:\n{out}")
                continue
            subprocess.run(["patch", "-p1", "--batch", "--forward", "-s",
                            "-d", str(MUTANT_TREE), "-i", str(patch)], check=True)
            print(f"== mutant {name}: {len(harnesses)} referencing harness(es)", flush=True)
            # Run the referencing harnesses as plain proofs: a kill is a
            # counterexample, so judge them with expect = pass.
            probes = [dict(h, expect="pass") for h in harnesses]
            verdicts, _ = run_harnesses(probes, args, root=MUTANT_TREE, tag=f"mutant-{name}-")
            killed = [v for _, v in verdicts if v.result == "fail"]
            for h, v in verdicts:
                print(f"   {h['name']}: {v.result}"
                      + (f" ({v.note})" if v.note else "")
                      + (f" [{'; '.join(v.violations)}]" if v.violations and v.result != "fail" else ""))
            if killed:
                print(f"   KILLED by {len(killed)}")
            else:
                failures.append(f"{name}: SURVIVED (no referencing harness found a counterexample)")
    finally:
        if saved is None:
            os.environ.pop("CARGO_TARGET_DIR", None)
        else:
            os.environ["CARGO_TARGET_DIR"] = saved
        if MUTANT_TREE.exists():
            shutil.rmtree(MUTANT_TREE)
    for f in failures:
        print(f)
    print(f"mutants: {len(names) - len(failures)} of {len(names)} killed")
    return 1 if failures else 0


# ---- selftest ---------------------------------------------------------------

SELFTEST_EXPECT = {
    # harness -> substring every violation list must contain (None: clean)
    "proofs::good": None,
    "proofs::fails": "result fail, manifest expects pass",
    "proofs::unsat_cover": "cover not satisfied (Unsatisfiable)",
    "proofs::vacuous_assume": "harness check unreachable",
    "proofs::library_branch_excluded": None,
    "proofs::exhausts_memory": "solver/resource error",
}


def selftest_manifest() -> list[dict]:
    base = dict(guarantee="SELF-1", crate="selftest", tier="pr", statement="", domain="",
                unwind=0, flags=[], time_budget_s=60, memory_budget_gb=1,
                unreachable=0, mutants=[], expect="pass", canary=False)
    return [dict(base, name=n) for n in SELFTEST_EXPECT]


def cmd_selftest(args) -> int:
    harnesses = selftest_manifest()
    env_root = SELFTEST.parent
    failures = []
    # The memory case runs alone under a deliberately tiny cap.
    normal = [h for h in harnesses if h["name"] != "proofs::exhausts_memory"]
    memory = [h for h in harnesses if h["name"] == "proofs::exhausts_memory"]
    saved = os.environ.get("CARGO_TARGET_DIR")
    os.environ["CARGO_TARGET_DIR"] = str(ENGINE / "target" / "selftest")
    try:
        verdicts, _ = run_harnesses(normal, args, root=env_root, tag="selftest-")
        # Compile uncapped first, so the tiny cap starves only CBMC.
        subprocess.run(["cargo", "kani", "--lib", "-Z", "unstable-options", "--harness",
                        "proofs::exhausts_memory", "--exact", "--only-codegen"], cwd=SELFTEST,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
        tiny = argparse.Namespace(**dict(vars(args), memory_cap_gb=0.15))
        more, _ = run_harnesses(memory, tiny, root=env_root, tag="selftest-memory-")
    finally:
        if saved is None:
            os.environ.pop("CARGO_TARGET_DIR", None)
        else:
            os.environ["CARGO_TARGET_DIR"] = saved
    for h, v in verdicts + more:
        want = SELFTEST_EXPECT[h["name"]]
        text = "; ".join(v.violations)
        if want is None and v.violations:
            failures.append(f"{h['name']}: expected clean, got {text}")
        elif want is not None and want not in text:
            failures.append(f"{h['name']}: expected a violation containing {want!r}, got {text!r}")
        else:
            print(f"selftest {h['name']}: as expected ({text or 'clean'})")
    for f in failures:
        print(f)
    return 1 if failures else 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--memory-cap-gb", type=float, default=8.0,
                        help="address-space limit for each cargo kani process tree (default 8)")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--tier", choices=("pr", "nightly", "all"), required=True)
    run.add_argument("--crate")
    run.add_argument("--id", help="guarantee ID prefix, e.g. MTR or MTR-3")
    sub.add_parser("check")
    ledger = sub.add_parser("ledger")
    ledger.add_argument("--check", action="store_true")
    mutants = sub.add_parser("mutants")
    mutants.add_argument("--id", help="mutant name prefix, e.g. MTR-2")
    sub.add_parser("selftest")
    args = parser.parse_args(argv)
    try:
        return {"run": cmd_run, "check": cmd_check, "ledger": cmd_ledger,
                "mutants": cmd_mutants, "selftest": cmd_selftest}[args.command](args)
    except ManifestError as e:
        print(e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
