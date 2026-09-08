#!/usr/bin/env python3
"""Select IronHorse jobs from the full PR or push range, without a files API cap."""

import json
import os
import subprocess


def git(*args):
    return subprocess.check_output(["git", *args])


def changed_paths(event):
    if "pull_request" in event:
        pr = event["pull_request"]
        revisions = [f"{pr['base']['sha']}...{pr['head']['sha']}"]
    else:
        if event.get("deleted"):
            return []
        before, after = event["before"], event["after"]
        if set(before) == {"0"}:
            return git("ls-tree", "-r", "--name-only", "-z", after).split(b"\0")
        # A force push can make the previous tip unreachable from fetched refs.
        # Fetch that exact commit if necessary; failure blocks the detector
        # rather than silently skipping checks on an unknown change set.
        if subprocess.run(["git", "cat-file", "-e", f"{before}^{{commit}}"],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            git("fetch", "--no-tags", "origin", before)
        revisions = [before, after]
    # Disable rename detection so both the old and new paths are considered.
    return git("diff", "--no-renames", "--name-only", "-z", *revisions, "--").split(b"\0")


def classify(paths):
    engine = oracle = False
    for raw in paths:
        path = os.fsdecode(raw)
        if path.endswith(".md"):
            continue
        common = (
            path.startswith(("rust/engine/", "rust/endo/ironhorse-store-sqlite/"))
            or path.startswith("rust/endo/src/ironhorse")
            or path in {
                "Cargo.toml", "Cargo.lock", "rust-toolchain.toml",
                "rust/endo/Cargo.toml", ".github/workflows/ci.yml",
                ".github/workflows/ironhorse-changes.yml",
            }
        )
        engine |= common
        oracle |= common or path.startswith("packages/test262-runner/test262/") or path in {
            "c/moddable", ".gitmodules",
            "rust/endo/xsnap/xsnap-platform.c", "rust/endo/xsnap/xsnap-platform.h",
            ".github/workflows/ironhorse-sanitizers.yml",
        }
    return {"engine": engine, "oracle": oracle}


def main():
    with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as stream:
        selected = classify(changed_paths(json.load(stream)))
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
        for name, value in selected.items():
            print(f"{name}={str(value).lower()}", file=stream)


if __name__ == "__main__":
    main()
