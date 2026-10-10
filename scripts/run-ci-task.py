#!/usr/bin/env python3
"""Run a Turbo task for explicitly selected workspaces; an empty set is a no-op."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess


def command(task, selected, root):
    """Build argv without shell expansion or Turbo's change-range heuristics."""
    if task not in {"test", "test:c8", "test:types", "test:xs", "lint:types"}:
        raise ValueError(f"Unsupported CI task: {task}")
    if not isinstance(selected, list) or any(not isinstance(n, str) for n in selected):
        raise ValueError("CI_PACKAGES must be a JSON array of workspace names")
    manifests = {}
    for path in root.glob("packages/*/package.json"):
        package = json.loads(path.read_text())
        manifests[package["name"]] = package
    names = []
    for name in sorted(set(selected)):
        # Reject Turbo filter operators, not just shell metacharacters.
        if not re.fullmatch(r"(?:@[a-z0-9._-]+/)?[a-z0-9][a-z0-9._-]*", name):
            raise ValueError(f"Invalid workspace name: {name!r}")
        if name not in manifests:
            raise ValueError(f"Unknown selected workspace: {name}")
        script = manifests[name].get("scripts", {}).get(task)
        if script and script.strip() != "exit 0" and name != "@endo/skel":
            names.append(name)
    if not names:
        return None
    args = ["corepack", "yarn", "turbo", "run", task]
    if task in {"test:types", "lint:types"}:
        args.append("--continue=always")
    return args + [f"--filter={name}" for name in names]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    argv = command(args.task, json.loads(os.environ["CI_PACKAGES"]), root)
    if argv is None:
        print(f"No affected workspaces implement {args.task}.")
        return
    subprocess.run(argv, cwd=root, check=True)


if __name__ == "__main__":
    main()
