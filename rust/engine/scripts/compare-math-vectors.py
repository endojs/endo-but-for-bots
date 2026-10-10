#!/usr/bin/env python3
"""Compare complete C5 guest-bit vectors; retain every difference, including ULPs."""

import csv
import sys
from pathlib import Path


def read(path):
    with Path(path).open() as stream:
        rows = list(csv.DictReader(stream, delimiter="\t"))
    result = {}
    for row in rows:
        key = row["function"], row["arguments"]
        bits = int(row["bits"], 16)
        if key in result and result[key] != bits:
            raise ValueError(f"inconsistent duplicate {key} in {path}")
        result[key] = bits
    if not result:
        raise ValueError(f"empty vector: {path}")
    return result


def ordered(bits):
    return (~bits & ((1 << 64) - 1)) if bits >> 63 else bits | (1 << 63)


def compare(left, right):
    if left.keys() != right.keys():
        raise ValueError("vector case sets differ")
    lines = ["function\targuments\tleft\tright\tulp_distance"]
    for key in left:
        a, b = left[key], right[key]
        if a != b:
            nan = lambda bits: bits & 0x7FFFFFFFFFFFFFFF > 0x7FF0000000000000
            distance = "n/a" if nan(a) or nan(b) else abs(ordered(a) - ordered(b))
            lines.append(f"{key[0]}\t{key[1]}\t{a:016x}\t{b:016x}\t{distance}")
    return lines


def matches_baseline(actual, expected):
    """An approved difference pins both output words, not just a ULP allowance."""
    for line in expected[1:]:
        fields = line.split("\t")
        if len(fields) != 5 or fields[0] in {"abs", "ceil", "floor", "sqrt"}:
            raise ValueError("invalid difference pin or exact-control exception")
        if fields[4] != "1":
            raise ValueError("the measured platform baseline permits only one-ULP differences")
    return actual == expected


def main():
    if len(sys.argv) not in (4, 5):
        raise ValueError("usage: compare-math-vectors.py LEFT RIGHT REPORT [EXPECTED_DIFFERENCES]")
    lines = compare(read(sys.argv[1]), read(sys.argv[2]))
    Path(sys.argv[3]).write_text("\n".join(lines) + "\n")
    print(f"{len(lines) - 1} bit differences; report: {sys.argv[3]}")
    expected = Path(sys.argv[4]).read_text().splitlines() if len(sys.argv) == 5 else [lines[0]]
    return int(not matches_baseline(lines, expected))


if __name__ == "__main__":
    sys.exit(main())
