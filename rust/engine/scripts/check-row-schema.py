#!/usr/bin/env python3
"""Compare row releases with the PR base; Rust tests pin current declarations."""
import argparse
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
PREFIX = "rust/engine/"
LEDGER = PREFIX + "ironhorse-snapshot/tests/fixtures/row_schema_releases.tsv"
FORMAT = PREFIX + "ironhorse-snapshot/src/format.rs"
STORE = PREFIX + "ironhorse-snapshot/src/store.rs"
API = PREFIX + "ironhorse-vm/src/snapshot_api.rs"


def entries(text):
    return [line for line in text.splitlines() if line and not line.startswith("#")]


def version(text, name):
    match = re.search(r"pub const " + name + r": u32 = (\d+);", text)
    if match is None:
        raise ValueError(f"missing version declaration: {name}")
    return int(match[1])


def verify(old_rows, new_rows, old_wire, new_wire, current_row):
    old, new = entries(old_rows), entries(new_rows)
    if new[:len(old)] != old:
        raise ValueError("row-schema release history was replaced or removed")
    if not new:
        raise ValueError("row-schema release ledger is empty")
    latest = new[-1].split("\t")
    if len(latest) != 4 or int(latest[0]) != current_row:
        raise ValueError("row schema does not match the latest ledger release")
    if len(new) > len(old) and old:
        if not all(after > before for before, after in zip(old_wire, new_wire)):
            raise ValueError("new row declarations must advance both wire versions beyond the base revision")
        if tuple(map(int, latest[1:3])) != new_wire:
            raise ValueError("new row release must record the newly advanced wire versions")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="PR base commit available in local history")
    args = parser.parse_args()
    # Resolve as an object ID before using it as the prefix of a git object path.
    base = subprocess.check_output(["git", "rev-parse", "--verify", "--end-of-options",
                                    args.base + "^{commit}"], cwd=ROOT, text=True).strip()

    def prior(path):
        return subprocess.check_output(["git", "show", f"{base}:{path}"], cwd=ROOT, text=True)

    exists = subprocess.run(["git", "cat-file", "-e", f"{base}:{LEDGER}"],
                            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    old_rows = prior(LEDGER) if exists.returncode == 0 else ""
    old_wire = (version(prior(FORMAT), "IRONHORSE_FORMAT_VERSION"),
                version(prior(STORE), "STORE_SCHEMA_VERSION"))
    new_wire = (version((ROOT / FORMAT).read_text(), "IRONHORSE_FORMAT_VERSION"),
                version((ROOT / STORE).read_text(), "STORE_SCHEMA_VERSION"))
    verify(old_rows, (ROOT / LEDGER).read_text(), old_wire, new_wire,
           version((ROOT / API).read_text(), "ROW_SCHEMA_VERSION"))
    print("Row-schema history and wire-version transition verified")


if __name__ == "__main__":
    main()
