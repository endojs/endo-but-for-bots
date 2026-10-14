#!/usr/bin/env python3
"""The cross-target gate: the native probe against the wasm32 probe under
Wasmtime, both built from the working tree, byte for byte.

WASM-BLOCKERS.md B7: a consensus build must give the same halt, result and
computrons on every target. This script builds the native and the
wasm32-wasip1 probes from the working tree (`build_probe.py`), hands both the
programs `differential.py` compares (the corpus, every family around its
ceiling, and the snippets in `differential/`, which include the B7 repros in
`differential/cross-target.js` and `cross-target.slow.js`), each with
`--digest` and `--meter-trace`, and fails on any difference in halt, result,
computrons, meter checks, bytecode, symbols or parse-meter charges. The wasm32
side runs under the Wasmtime CLI at lane A's `max-wasm-stack`. An engine panic
on either side is part of that side's outcome, so a panic on one target is a
divergence like any other.

Verdicts:

  same           both targets printed the same line;
  expected       a divergence that `expected-divergence/wasmtime.json` lists,
                 with exactly the native and wasm32 lines it records;
  expected-trap  a corpus case that lane A's expected-trap list names trapped
                 under Wasmtime;
  differs        a divergence the list does not name (a failure);
  changed        a listed program that diverges otherwise than recorded (a
                 failure; `--update-expected` re-records it);
  stale          a listed program that no longer diverges (a failure;
                 `--update-expected` removes it);
  native-trap    the native reference trapped or panicked (a failure, never
                 expected);
  timeout        either target timed out (a failure);
  error          the harness could not read a line (a failure).

A listed program that no longer exists fails too. The list may only shrink:
a B7 fix removes the entries it clears, and a new divergence is added by hand
with the B7 site it belongs to, never by `--update-expected`.

  python3 cross_target.py                      # the fast shard
  python3 cross_target.py --no-build --shard slow
  python3 cross_target.py --program 'snippet cross-target.js#regexp-advance-index-replace'
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_probe  # noqa: E402
import common  # noqa: E402
import differential  # noqa: E402
import lane_a  # noqa: E402

EXPECTED = common.LANES / "expected-divergence/wasmtime.json"
MAX_WASM_STACK = lane_a.DEFAULT_STACK
FIELDS = ("program", "site", "native", "wasm32")
PASSING = ("same", "expected", "expected-trap")


class ListError(ValueError):
    pass


class ExpectedDivergences:
    """The expected-divergence list: one entry per program whose native and
    wasm32 lines may differ, naming both lines and the B7 site the
    divergence belongs to. The `config` it was recorded under (the wasm32
    side's stack) must match a check."""

    def __init__(self, path, config):
        self.path = Path(path)
        self.config = config
        listed = common.load_json(self.path, {"config": config, "expected_divergences": []})
        self.recorded_config = listed.get("config")
        self.entries = {}
        for entry in listed.get("expected_divergences", []):
            if not isinstance(entry, dict) or sorted(entry) != sorted(FIELDS):
                raise ListError(f"{self.path}: an entry has exactly the fields {list(FIELDS)}: {entry!r}")
            empty = [field for field in FIELDS if not isinstance(entry[field], str) or not entry[field]]
            if empty:
                raise ListError(f"{self.path}: {entry['program']!r} has no {', '.join(empty)}")
            if entry["program"] in self.entries:
                raise ListError(f"{self.path}: {entry['program']!r} is listed twice")
            if entry["native"] == entry["wasm32"]:
                raise ListError(f"{self.path}: {entry['program']!r} records no divergence")
            self.entries[entry["program"]] = dict(entry)

    def config_matches(self):
        return self.recorded_config == self.config

    def write(self):
        """Write the list with each entry's fields in reading order (program,
        site, native, wasm32), keeping the entries' order."""
        entries = [{field: entry[field] for field in FIELDS} for entry in self.entries.values()]
        self.path.write_text(json.dumps({"config": self.config, "expected_divergences": entries}, indent=2) + "\n")


# ---- running ---------------------------------------------------------------

def native_outcome(probe, program, timeout):
    result = common.run_native(probe, ["source", *program.flags, *differential.COMPARED], stdin=program.source,
                               timeout=timeout, panics=True)
    return common.describe(result)


def wasm_outcome(wasmtime, wasm, program, timeout, max_wasm_stack=MAX_WASM_STACK):
    result = common.run_wasmtime(wasmtime, wasm, ["source", *program.flags, *differential.COMPARED],
                                 max_wasm_stack, stdin=program.source, timeout=timeout, panics=True)
    return common.describe(result)


def compare(native, wasmtime, wasm, work, jobs, timeout, max_wasm_stack=MAX_WASM_STACK, seconds=None):
    """(program, native line, wasm32 line, error) for every Program of `work`.
    With a `seconds` dict, each label's wall-clock time on both targets is
    added to it."""
    def timed(run):
        def host(program):
            t0 = time.monotonic()
            try:
                return run(program)
            finally:
                if seconds is not None:
                    seconds[program.label] = seconds.get(program.label, 0) + time.monotonic() - t0
        return host

    return common.run_pairs(
        work,
        timed(lambda program: native_outcome(native, program, timeout)),
        timed(lambda program: wasm_outcome(wasmtime, wasm, program, timeout, max_wasm_stack)),
        jobs, serial=lambda program: program.slow)


# ---- verdicts --------------------------------------------------------------

def classify(native, wasm32, entry, trap_listed):
    """One program's verdict from its two lines, its expected-divergence entry
    (or None), and whether lane A's expected-trap list names it."""
    if "timeout" in (native, wasm32):
        return "timeout"
    if native.startswith("trap:"):
        return "native-trap"
    if native == wasm32:
        return "stale" if entry else "same"
    if entry is not None:
        return "expected" if (entry["native"], entry["wasm32"]) == (native, wasm32) else "changed"
    if trap_listed and wasm32.startswith("trap:") and any(m in wasm32 for m in common.WASMTIME_TRAP):
        return "expected-trap"
    return "differs"


def lane_a_case(label):
    """The corpus case a label names, for lane A's list (keyed by case)."""
    prefix = differential.case_label("")
    return label[len(prefix):] if label.startswith(prefix) else None


def evaluate(pairs, expected, trap_names, known):
    """The verdict on every compared program and the problems that fail the
    run. `known` is every program label in every shard: a listed program
    outside it no longer exists, and a listed program this run did not
    compare is left unchecked."""
    rows = []
    for program, native, wasm32, error in pairs:
        entry = expected.entries.get(program.label)
        if error is not None:
            verdict, native, wasm32 = "error", error, ""
        else:
            verdict = classify(native, wasm32, entry, lane_a_case(program.label) in trap_names)
        rows.append({"program": program.label, "verdict": verdict, "native": native, "wasm32": wasm32,
                     "site": entry["site"] if entry else None})
    problems = []
    for row in rows:
        if row["verdict"] not in PASSING:
            problems.append(f"{row['verdict']}: {row['program']}")
    for label in expected.entries:
        if label not in known:
            problems.append(f"orphan: {label} is listed but no such program exists")
    return rows, problems


def update(expected, rows, known):
    """Rewrite the list from a run: drop the entries whose divergence is gone
    (stale) or whose program is gone (orphan), and re-record the lines of the
    entries whose divergence changed. Entries outside the run are kept, and a
    divergence the list does not name is never added: an entry needs the B7
    site, which only the person adding it knows. Returns the verdicts the
    rewrite answers."""
    answered = set()
    for row in rows:
        label = row["program"]
        if row["verdict"] == "stale":
            del expected.entries[label]
            answered.add(label)
        elif row["verdict"] == "changed":
            expected.entries[label].update(native=row["native"], wasm32=row["wasm32"])
            answered.add(label)
    for label in [label for label in expected.entries if label not in known]:
        del expected.entries[label]
    expected.write()
    return answered


def template(row):
    """A list entry for an unlisted divergence, for pasting with its site."""
    return json.dumps({"program": row["program"], "site": "<the B7 site>", "native": row["native"],
                       "wasm32": row["wasm32"]}, indent=2)


# ---- main ------------------------------------------------------------------

def wasmtime_path(name):
    found = shutil.which(name)
    if found:
        return found
    if Path(name).is_file():
        return name
    raise SystemExit(f"no Wasmtime CLI at {name!r}; set $WASMTIME or pass --wasmtime (Wasmtime 49, as lane A)")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--shard", choices=("fast", "slow", "all"), default="fast",
                        help="fast: everything but the slow programs; slow: only them")
    parser.add_argument("--only", choices=("corpus", "families", "snippets"))
    parser.add_argument("--program", action="append", help="compare only these programs (by label)")
    parser.add_argument("--jobs", type=int, default=os.cpu_count() or 2)
    parser.add_argument("--timeout", type=int, default=900, help="seconds per run on each target")
    parser.add_argument("--no-build", action="store_true", help="use the last native and wasm32 builds")
    parser.add_argument("--wasmtime", default=common.wasmtime_binary())
    parser.add_argument("--expected", type=Path, default=EXPECTED)
    parser.add_argument("--update-expected", action="store_true",
                        help="remove the stale entries and re-record the changed ones (never adds one)")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args(argv)

    wasmtime = wasmtime_path(args.wasmtime)
    if args.no_build:
        native, wasm = build_probe.artifact(), build_probe.artifact(build_probe.WASM_TARGET)
        for path in (native, wasm):
            if not path.exists():
                parser.error(f"no build at {path}; run build_probe.py or drop --no-build")
    else:
        native = build_probe.build(quiet=True)
        wasm = build_probe.build(build_probe.WASM_TARGET, quiet=True)

    config = {"max_wasm_stack": MAX_WASM_STACK}
    traps = common.ExpectedTraps(lane_a.EXPECTED, config)
    if not traps.config_matches():
        parser.error(f"{lane_a.EXPECTED} was recorded at {traps.recorded_config}, not {config}; "
                     "re-record lane A's list first")
    try:
        expected = ExpectedDivergences(args.expected, config)
    except ListError as error:
        parser.error(str(error))
    whole = args.shard == "all" and not args.only and not args.program
    if not expected.config_matches():
        if not args.update_expected:
            parser.error(f"{args.expected} was recorded at {expected.recorded_config}, not {config}; "
                         "pass --update-expected to re-record it")
        if not whole:
            parser.error("re-recording the list under a new configuration needs every program: "
                         "--shard all and no --only or --program")

    known = differential.labels(native)
    if args.program:
        unknown = sorted(set(args.program) - known)
        if unknown:
            parser.error(f"unknown programs: {unknown}")
    work = differential.inputs(native, "all" if args.program else args.shard, args.only, args.jobs)
    if args.program:
        work = [program for program in work if program.label in args.program]
    if not work:
        print(f"FAIL: no programs in shard {args.shard}; a gate that runs nothing proves nothing")
        return 1

    plural = "" if len(work) == 1 else "s"
    print(f"comparing {len(work)} program{plural}: native against wasm32 under Wasmtime at "
          f"max_wasm_stack={MAX_WASM_STACK}", flush=True)
    started = time.monotonic()
    seconds = {}
    pairs = compare(native, wasmtime, wasm, work, args.jobs, args.timeout, seconds=seconds)
    rows, problems = evaluate(pairs, expected, traps.names, known)
    for row in rows:
        row["seconds"] = round(seconds.get(row["program"], 0), 2)

    counts = {}
    for row in rows:
        counts[row["verdict"]] = counts.get(row["verdict"], 0) + 1
        if row["verdict"] == "same":
            continue
        site = f"  ({row['site']})" if row["site"] else ""
        print(f"{row['verdict']:13s} {row['program']}{site}")
        if row["verdict"] not in PASSING:
            print(f"  native: {row['native']}\n  wasm32: {row['wasm32']}")
            if row["verdict"] == "differs":
                print("  an entry for expected-divergence/wasmtime.json, if this is a B7 site:\n    "
                      + template(row).replace("\n", "\n    "))
    compared = {row["program"] for row in rows}
    unchecked = [label for label in expected.entries if label in known and label not in compared]

    if args.update_expected:
        if not expected.config_matches():
            expected.config = config
        answered = update(expected, rows, known)
        problems = [p for p in problems
                    if not (p.startswith(("stale: ", "changed: ")) and p.split(": ", 1)[1] in answered)
                    and not p.startswith("orphan: ")]
        print(f"wrote {args.expected} ({len(expected.entries)} expected divergences)")
    if args.output:
        common.write_json(args.output, {"max_wasm_stack": MAX_WASM_STACK, "shard": args.shard,
                                        "results": rows, "problems": problems,
                                        "seconds": round(time.monotonic() - started, 1)})
    slowest = sorted(rows, key=lambda row: -row["seconds"])[:5]
    print("slowest: " + ", ".join(f"{row['program']} ({row['seconds']:.0f}s)" for row in slowest))
    for problem in problems:
        print(f"FAIL: {problem}")
    print("cross-target: " + ", ".join(f"{n} {v}" for v, n in sorted(counts.items()))
          + (f"; {len(unchecked)} listed programs outside this run" if unchecked else "")
          + f" ({time.monotonic() - started:.0f}s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
