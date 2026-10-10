#!/usr/bin/env python3
"""Measure native stack high-water marks and gate them against a baseline.

Runs `ironhorse-vm/tests/stack_height.rs` in release mode, parses its
`STACK_METRIC` lines and compares each case against `stack-height-baseline.json`.
A case fails the check when it uses more stack than the baseline allows or
when its outcome (completed, ReentryLimit, ...) changes. Frame sizes are a
property of the build, so the baseline records the compiler, target and
profile it was measured with, and the check refuses a mismatch unless told
otherwise.

Within one build the marks still vary from run to run, by up to about 1.4%:
the standard library seeds its hash tables randomly in each process, which
changes what runs at a case's deepest point. The baseline's 2% slack
(`DEFAULT_SLACK`) absorbs that variation.

The baseline also records the engine tree it was measured at: the hash of
HEAD's `rust/engine` tree with the baseline file left out. A tree hash names
content, so it survives the rebase-merge that rewrites the commit a baseline
was measured at, after which that commit is on no branch. The baseline file is
left out because it lies inside the tree it describes: no file can hold the
hash of a tree that holds that file, and without it, writing and committing
the baseline leaves the hash where it was, so the baseline's own commit holds
the tree it names. `--write-baseline` refuses a tree with uncommitted engine
changes, which HEAD's tree would not reproduce: commit the change, write the
baseline, and commit the baseline on its own. `--allow-dirty` writes one
anyway and records `"dirty": true`. The check says whether the checkout holds
the baseline's tree.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "benches/stack-height-baseline.json"
DEFAULT_SLACK = 0.02
PROVENANCE_KEYS = ("target", "rustc", "profile")


def parse_metrics(output):
    """`STACK_METRIC <case>.<stage> <bytes> <outcome> [result=...]` lines to a dict."""
    metrics = {}
    for line in output.splitlines():
        if not line.startswith("STACK_METRIC "):
            continue
        fields = line.split(maxsplit=4)
        if len(fields) < 4:
            raise ValueError(f"malformed metric line: {line!r}")
        _, name, raw, outcome = fields[:4]
        value = int(raw)
        if name in metrics or value < 0:
            raise ValueError(f"duplicate or invalid metric: {name}")
        metrics[name] = {"bytes": value, "outcome": outcome}
    return metrics


def compare(actual, baseline, slack):
    """Problems (a list of strings) and notes for cases well under the baseline."""
    problems = []
    notes = []
    if actual.keys() != baseline.keys():
        missing = sorted(baseline.keys() - actual.keys())
        unexpected = sorted(actual.keys() - baseline.keys())
        problems.append(f"case roster differs: missing={missing}, unexpected={unexpected}")
    for name, expected in baseline.items():
        if name not in actual:
            continue
        limit = int(expected["bytes"] * (1 + slack))
        measured = actual[name]
        if measured["outcome"] != expected["outcome"]:
            problems.append(
                f"{name}: outcome {measured['outcome']} (baseline {expected['outcome']})"
            )
        if measured["bytes"] > limit:
            problems.append(
                f"{name}: {measured['bytes']} B > {limit} B "
                f"({measured['bytes'] / expected['bytes']:.3f}x of baseline {expected['bytes']} B)"
            )
        elif expected["bytes"] and measured["bytes"] < expected["bytes"] * (1 - slack):
            notes.append(
                f"{name}: {measured['bytes']} B, {measured['bytes'] / expected['bytes']:.3f}x of "
                f"baseline {expected['bytes']} B; lower the baseline with --write-baseline"
            )
    return problems, notes


def validate_provenance(reference, candidate):
    for key in PROVENANCE_KEYS:
        if reference.get(key) != candidate.get(key):
            raise ValueError(
                f"baseline provenance differs: {key} is {candidate.get(key)!r}, "
                f"baseline has {reference.get(key)!r}"
            )


def uncommitted_changes(baseline, root=ROOT):
    """Tracked paths under the engine `root` whose working copy differs from
    HEAD, the baseline file itself excepted (re-writing it is not a change to
    what it measures)."""
    root = Path(root).resolve()
    command = ["git", "status", "--porcelain=v1", "--untracked-files=no", "--", "."]
    try:
        command.append(f":(exclude){Path(baseline).resolve().relative_to(root)}")
    except ValueError:
        pass  # a baseline outside the engine is not under the pathspec
    output = subprocess.check_output(command, cwd=root, text=True)
    return [line[3:] for line in output.splitlines() if line.strip()]


def git(root, *args, stdin=None):
    return subprocess.run(["git", *args], cwd=root, input=stdin, stdout=subprocess.PIPE,
                          check=True).stdout


def tree_without(root, tree, path):
    """The hash of `tree` with the entry at `path` (a tuple of byte-string
    names) left out, as git would write it: `tree` itself when it has no such
    entry, None when nothing is left. The pruned trees are hashed, never
    written to the object store."""
    name, rest = path[0], path[1:]
    entries = []
    pruned = False
    # `--full-tree`: run in a subdirectory, ls-tree lists only the entries
    # under that subdirectory's path.
    for record in git(root, "ls-tree", "--full-tree", "-z", tree).split(b"\0"):
        if not record:
            continue
        meta, entry = record.split(b"\t", 1)
        mode, kind, oid = meta.decode().split()
        if entry == name and not rest:
            pruned = True
            continue
        if entry == name and kind == "tree":
            inner = tree_without(root, oid, rest)
            pruned = inner != oid
            if inner is None:
                continue  # git keeps no empty directory
            oid = inner
        entries.append(b"%o %s\0" % (int(mode, 8), entry) + bytes.fromhex(oid))
    if not pruned:
        return tree
    if not entries:
        return None
    return git(root, "hash-object", "-t", "tree", "--stdin", stdin=b"".join(entries)).decode().strip()


def engine_tree(baseline, root=ROOT, revision="HEAD"):
    """The hash of the engine `root`'s tree at `revision` with the baseline
    file left out: the tree a baseline names (see the module docstring)."""
    root = Path(root).resolve()
    tree = git(root, "rev-parse", "--verify", f"{revision}:./").decode().strip()
    try:
        relative = Path(baseline).resolve().relative_to(root)
    except ValueError:
        return tree  # a baseline outside the engine is not in its tree
    return tree_without(root, tree, tuple(os.fsencode(part) for part in relative.parts))


def provenance(baseline, changed=()):
    """The build and engine tree the marks belong to; `dirty` when the
    checkout had uncommitted engine changes, which HEAD's tree does not
    hold."""
    verbose = subprocess.check_output(["rustc", "-vV"], cwd=ROOT, text=True)
    host = next(line.split(": ", 1)[1] for line in verbose.splitlines() if line.startswith("host: "))
    record = {
        "target": host,
        "rustc": verbose.splitlines()[0].strip(),
        "profile": "release",
        "engine_tree": engine_tree(baseline),
    }
    if changed:
        record["dirty"] = True
    return record


def describe_tree(baseline, current):
    """Whether the checkout (`current` provenance) holds the engine tree the
    `baseline` provenance was measured at."""
    def tree(record):
        dirty = " with uncommitted changes" if record.get("dirty") else ""
        return f"{record['engine_tree'][:12]}{dirty}"

    if "engine_tree" not in baseline:
        return "the baseline records no engine tree"
    if (baseline["engine_tree"] == current["engine_tree"]
            and not baseline.get("dirty") and not current.get("dirty")):
        return f"the baseline was measured at this engine tree, {tree(current)}"
    return f"the baseline was measured at engine tree {tree(baseline)}; this one is {tree(current)}"


def refuse_dirty(changed, allow_dirty):
    """The reason a baseline may not be written from this tree, or None."""
    if not changed or allow_dirty:
        return None
    shown = ", ".join(changed[:10]) + (f" and {len(changed) - 10} more" if len(changed) > 10 else "")
    return (f"uncommitted engine changes ({shown}): the baseline would name an engine tree that "
            "does not reproduce its marks. Commit them, write the baseline and commit it on its "
            "own, or pass --allow-dirty to record a dirty baseline")


def measure():
    env = dict(os.environ, CARGO_INCREMENTAL="0")
    result = subprocess.run(
        ["cargo", "test", "--locked", "--release", "-p", "ironhorse-vm", "--test", "stack_height",
         "--", "--ignored", "--nocapture", "--test-threads=1"],
        cwd=ROOT, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    print(result.stdout, end="", flush=True)
    if result.returncode:
        raise SystemExit(f"stack_height failed: exit={result.returncode}")
    metrics = parse_metrics(result.stdout)
    if not metrics:
        raise SystemExit("stack_height printed no STACK_METRIC lines")
    return metrics


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=BASELINE)
    parser.add_argument("--output", type=Path, help="write the measurements and comparison as JSON")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="compare against the baseline (default)")
    mode.add_argument("--write-baseline", action="store_true")
    parser.add_argument("--slack", type=float, help="allowed growth over the baseline (default: the baseline's)")
    parser.add_argument("--ignore-provenance", action="store_true",
                        help="compare even when compiler, target or profile differ from the baseline")
    parser.add_argument("--allow-dirty", action="store_true",
                        help="with --write-baseline, write from uncommitted changes, recorded as dirty")
    args = parser.parse_args()

    changed = uncommitted_changes(args.baseline)
    if args.write_baseline:
        reason = refuse_dirty(changed, args.allow_dirty)
        if reason:
            raise SystemExit(f"stack height: {reason}")
    current = provenance(args.baseline, changed)
    metrics = measure()
    report = {"provenance": current, "cases": metrics}

    if args.write_baseline:
        baseline = {
            "provenance": current,
            "slack": DEFAULT_SLACK if args.slack is None else args.slack,
            "cases": metrics,
        }
        args.baseline.write_text(json.dumps(baseline, indent=2) + "\n")
        print(f"wrote {args.baseline} ({len(metrics)} cases)")
        if args.output:
            args.output.write_text(json.dumps(report, indent=2) + "\n")
        return 0

    baseline = json.loads(args.baseline.read_text())
    slack = baseline["slack"] if args.slack is None else args.slack
    if not args.ignore_provenance:
        validate_provenance(baseline["provenance"], current)
    problems, notes = compare(metrics, baseline["cases"], slack)
    report.update({"baseline": baseline["provenance"], "slack": slack,
                   "problems": problems, "notes": notes})
    if args.output:
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    width = max(len(name) for name in metrics)
    for name in sorted(metrics):
        measured = metrics[name]
        expected = baseline["cases"].get(name)
        ratio = f"{measured['bytes'] / expected['bytes']:.3f}x" if expected and expected["bytes"] else "new"
        print(f"{name:{width}s} {measured['bytes']:>9d} B  {ratio:>7s}  {measured['outcome']}")
    print(f"stack height: {describe_tree(baseline['provenance'], current)}")
    for note in notes:
        print(f"note: {note}")
    for problem in problems:
        print(f"FAIL: {problem}")
    if problems:
        return 1
    print(f"stack height: {len(metrics)} cases within {slack:.0%} of the baseline")
    return 0


if __name__ == "__main__":
    sys.exit(main())
