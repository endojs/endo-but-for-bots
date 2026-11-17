#!/usr/bin/env python3
"""Run the engine's own test suites under the ROOT workspace's resolution.

The repository has two Cargo workspaces and two lockfiles: the root one, whose
resolution the shipped `endor` binary links, and `rust/engine`'s, under which
every engine crate's test suite runs. `scripts/check-lockfile-agreement.py`
proves the two AGREE on every package reachable from the shared IronHorse path
crates, which closes the free-drift half of architecture finding F070. What it
does not do is run anything: the engine's vm, snapshot, compile, regexp and
meter suites have never executed against the resolution that ships, and
`cargo test -p ironhorse-vm` from the repository root refuses outright —

    error: package `ironhorse-vm` cannot be tested because it requires
    dev-dependencies and is not a member of the workspace

— which is the residue, stated by the tool itself.

Folding `rust/engine` into the root workspace would subsume all of this, and
is what the finding recommends. It would also overturn a recorded design
decision (the engine's `Cargo.toml` documents the separation as resolved
question 9: an independent workspace so the oracle-locked transliteration
builds in-repo from the first commit without perturbing `rust/`). Reversing a
decision of record is a bigger call than closing a finding, so this script
takes the other route the finding leaves open: build the unified resolution in
a temporary workspace and run the engine suites there, so the question "do the
engine's own tests pass under the resolution that ships?" has an answer
without changing what ships.

The temporary workspace unions both member lists and resolves fresh. Nothing
is written inside the repository; the manifest and the target directory live
in a scratch directory that is removed afterwards.

    python3 rust/engine/scripts/check-unified-resolution.py --crates ironhorse-vm

Expensive: a fresh resolve and a cold build of the engine and the XS oracle.
Belongs in a scheduled lane, not on every pull request — the per-pull-request
protection is the lockfile-agreement check, which is cheap and catches drift
before it can matter.
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
REPO = ENGINE.parents[1]

# The engine crates whose suites this runs. `xs-oracle` builds C sources and
# `ironhorse-262` drives test262; both are harness rather than shipped engine,
# and both are already exercised elsewhere.
DEFAULT_CRATES = (
    "ironhorse-vm",
    "ironhorse-snapshot",
    "ironhorse-compile",
    "ironhorse-regexp",
    "ironhorse-meter",
    "ironhorse-text",
    "ironhorse-unicode",
)


def members(manifest: Path) -> list[str]:
    with manifest.open("rb") as handle:
        data = tomllib.load(handle)
    workspace = data.get("workspace", {})
    return list(workspace.get("members", []))


def inheritance_sections(manifest: Path) -> str:
    """The `[workspace.package]`, `[workspace.lints…]` and
    `[workspace.dependencies]` tables of `manifest`, verbatim.

    Members inherit from these with `field.workspace = true`, so a unified
    root that drops them cannot even parse the members.
    """
    text = manifest.read_text().splitlines()
    out: list[str] = []
    keeping = False
    for line in text:
        if line.startswith("["):
            keeping = line.startswith("[workspace.package") or line.startswith(
                "[workspace.lints"
            ) or line.startswith("[workspace.dependencies")
        if keeping:
            out.append(line)
    return "\n".join(out)


def build_unified_workspace(scratch: Path) -> Path:
    """Stage a copy of `rust/` under one workspace root.

    A package belongs to the workspace whose root directory contains it, so a
    scratch manifest cannot simply list the two trees' members: cargo refuses
    with "is a member of the wrong workspace". The tree therefore has to be
    somewhere neither existing workspace root contains, which means a copy.

    `rust/` is about 45 MB without its target directories, so the copy is
    cheap; the expensive part is the cold build that follows. `c/moddable` is
    symlinked rather than copied — it is the XS submodule, it is large, and
    `xs-oracle`'s build script reaches it by a relative path that the layout
    below preserves.
    """
    staged = scratch / "rust"
    shutil.copytree(
        REPO / "rust",
        staged,
        ignore=shutil.ignore_patterns("target", ".git"),
        symlinks=True,
    )
    # Several crates reach OUT of `rust/` by relative path: `xs-oracle`'s
    # build script wants `<crate>/../../../c/moddable`, and the compile and
    # 262 suites read the converted corpus under
    # `packages/test262-runner/`. From `<scratch>/rust/engine/<crate>` those
    # are `<scratch>/c/...` and `<scratch>/packages/...`, so the staged tree
    # has to carry them. Symlinks rather than copies: the XS submodule and
    # the corpus are large and neither is being resolved.
    for name in ("c", "packages"):
        link = scratch / name
        if not link.exists():
            link.symlink_to(REPO / name, target_is_directory=True)

    # Root members are already repo-root-relative (`rust/endo`), and the
    # copy preserves that path; engine members are relative to
    # `rust/engine`, so only those need a prefix.
    root_members = list(members(REPO / "Cargo.toml"))
    engine_members = [
        f"rust/engine/{m}" for m in members(ENGINE / "Cargo.toml")
    ]
    lines = [
        "# GENERATED by rust/engine/scripts/check-unified-resolution.py.",
        "# A throwaway workspace over a COPY of rust/, unioning the",
        "# repository's two member lists so the engine's suites can run",
        "# under one resolution (architecture finding F070).",
        "[workspace]",
        'resolver = "2"',
        "members = [",
    ]
    for member in sorted(set(root_members + engine_members)):
        lines.append(f'    "{member}",')
    lines += [
        "]",
        "",
        "# Guest-influenced arithmetic must not silently wrap, as in both",
        "# real workspaces.",
        "[profile.release]",
        "overflow-checks = true",
        "",
        "# The engine crates inherit `version`, `edition`, `license` and the",
        "# clippy allowances from their own workspace root through",
        "# `field.workspace = true`. That root is about to stop existing, so",
        "# its inheritance tables move here verbatim: the point of the",
        "# exercise is to change the RESOLUTION, not the crates' settings.",
        inheritance_sections(ENGINE / "Cargo.toml"),
    ]
    # The engine's nested workspace manifest would claim its own members
    # again; strip it so the unified root owns them.
    (staged / "engine" / "Cargo.toml").unlink()
    (scratch / "rust" / "engine" / "Cargo.lock").unlink(missing_ok=True)

    manifest = scratch / "Cargo.toml"
    manifest.write_text("\n".join(lines) + "\n")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--crates", nargs="*", default=list(DEFAULT_CRATES),
        help="engine crates whose suites to run",
    )
    parser.add_argument(
        "--print-manifest", action="store_true",
        help="write the unified manifest, print it, and stop",
    )
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="ironhorse-unified-") as scratch_name:
        scratch = Path(scratch_name)
        manifest = build_unified_workspace(scratch)
        if args.print_manifest:
            print(manifest.read_text(), end="")
            return 0

        command = [
            "cargo", "test", "--release", "--manifest-path", str(manifest),
        ]
        for crate in args.crates:
            command += ["-p", crate]
        env = dict(os.environ)
        # Keep the build out of either workspace's target directory, so a
        # unified-resolution build cannot poison an ordinary one.
        env["CARGO_TARGET_DIR"] = str(scratch / "target")
        env.setdefault("RUST_MIN_STACK", "33554432")
        print(f"$ {' '.join(command)}", flush=True)
        result = subprocess.run(command, env=env, check=False)
        if result.returncode:
            print(
                "::error::the engine's suites do not pass under the root "
                "workspace's resolution; the artifact under test and the "
                "artifact under ship disagree (F070)",
                file=sys.stderr,
            )
        return result.returncode


if __name__ == "__main__":
    if shutil.which("cargo") is None:
        print("error: cargo is not on PATH", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(main())
