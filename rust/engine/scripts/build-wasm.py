#!/usr/bin/env python3
"""Build the engine for wasm with unwinding: the official wasm build.

WASM-BLOCKERS.md B1, option 1, adopted. The engine uses unwinding as a
control transfer (`HeapExhausted`, the parse meter's `Refused`, the coder's
`Poisoned`, which a guest catches as a `SyntaxError` through `eval`, and the
RegExp compiler's `CompileStop`), and `ironhorse-compile` refuses
`panic=abort`, the only strategy the std that stable Rust ships for its wasm
targets is built with. So std is rebuilt with unwinding from the pinned
toolchain's `rust-src` (`-Zbuild-std`), under `RUSTC_BOOTSTRAP=1` and never a
nightly channel: the pinned 1.91.1 with its pinned `rust-src` is
reproducible, a nightly channel is not.

This file is the one place the recipe lives; `stack-lanes/build_probe.py`
imports its flags and environment. The decisions it encodes:

- `-C panic=unwind -C target-feature=+exception-handling`: unwinding over
  wasm exception handling, the B1 workaround.
- `-C llvm-args=-wasm-use-legacy-eh=false`: the standard `exnref` encoding
  (B2). Wasmtime 49 rejects legacy EH; Node 22, Chromium 141 and workerd run
  exnref. It is in RUSTFLAGS so that `-Zbuild-std` compiles std with the same
  encoding.
- `-C link-arg=-zstack-size=4194304`: a 4 MiB shadow stack (the appendix);
  the worst accepted composition measured needs more than 2 MiB today.
- `ironhorse-vm` with `consensus` (B4): the platform libm diverges between
  glibc and wasi-libc, and with it results and computrons.
- Overflow checks stay on: the workspace `release` profile sets them.

Setup, on the pinned toolchain (rustup reads rust-toolchain.toml from this
workspace, so run these from rust/engine, or name the toolchain):

    rustup component add rust-src
    rustup target add wasm32-wasip1 wasm32-unknown-unknown
    python3 scripts/build-wasm.py

Every workspace member that can target wasm is built as a library for both
targets. The members left out are host tools: the XS oracle bindings, the
test262 runner and the fuzz targets.
"""
import argparse
import os
from pathlib import Path
import shlex
import subprocess

ENGINE = Path(__file__).resolve().parents[1]
WASIP1 = "wasm32-wasip1"
UNKNOWN = "wasm32-unknown-unknown"
TARGETS = (WASIP1, UNKNOWN)
CRATES = (
    "ironhorse-meter", "ironhorse-text", "ironhorse-unicode", "ironhorse-regexp",
    "ironhorse-vm", "ironhorse-compile", "ironhorse-runtime", "ironhorse-snapshot",
)
# Cargo's `package/feature` form, so the feature lands on one member of a
# multi-package build.
FEATURES = ("ironhorse-vm/consensus",)
DEFAULT_SHADOW_STACK = 4 * 1024 * 1024
BUILD_STD = "-Zbuild-std=std,panic_unwind"


def rustflags(shadow_stack=DEFAULT_SHADOW_STACK, extra=()):
    """The RUSTFLAGS of the wasm build, one option per item, then `extra`: a
    caller's own, such as the probe's `--export=__stack_pointer`."""
    return [
        "-C panic=unwind",
        "-C target-feature=+exception-handling",
        "-C llvm-args=-wasm-use-legacy-eh=false",
        f"-C link-arg=-zstack-size={shadow_stack}",
        *extra,
    ]


def environment(shadow_stack=DEFAULT_SHADOW_STACK, extra_rustflags=(), base=None):
    """The build's environment over `base` (this process's by default):
    RUSTC_BOOTSTRAP, for -Zbuild-std and the unstable target feature, and
    RUSTFLAGS. Cargo applies RUSTFLAGS to the target's crates only when
    --target is explicit, as it always is here, so host build scripts and
    proc macros are untouched. An inherited CARGO_ENCODED_RUSTFLAGS would
    take precedence over RUSTFLAGS, so it is dropped."""
    env = dict(os.environ if base is None else base)
    env.pop("CARGO_ENCODED_RUSTFLAGS", None)
    env["RUSTC_BOOTSTRAP"] = "1"
    env["RUSTFLAGS"] = " ".join(rustflags(shadow_stack, extra_rustflags))
    return env


def profile_arguments(profile):
    """Cargo's spelling of a profile: --release, nothing for dev, --profile otherwise."""
    if profile == "release":
        return ["--release"]
    if profile == "dev":
        return []
    return ["--profile", profile]


def profile_directory(profile):
    """The target subdirectory a profile's artifacts land in."""
    return "debug" if profile == "dev" else profile


def build_arguments(target, profile="release"):
    """`cargo build` under the recipe for one wasm target, before the crate
    selection: std and panic_unwind are rebuilt from rust-src for that target."""
    return ["cargo", "build", BUILD_STD, "--target", target, *profile_arguments(profile)]


def crate_arguments(crates=CRATES, features=FEATURES):
    """-p for each crate, and the features of the crates among them."""
    arguments = []
    for crate in crates:
        arguments += ["-p", crate]
    selected = [feature for feature in features if feature.split("/", 1)[0] in crates]
    if selected:
        arguments += ["--features", ",".join(selected)]
    return arguments


def target_directory():
    """Cargo's target directory for this workspace: CARGO_TARGET_DIR, relative
    to the workspace when relative, else `target`."""
    configured = os.environ.get("CARGO_TARGET_DIR")
    if not configured:
        return ENGINE / "target"
    return Path(configured) if os.path.isabs(configured) else ENGINE / configured


def artifact(crate, target, profile="release"):
    """Where cargo puts a crate's library for a target."""
    name = "lib" + crate.replace("-", "_") + ".rlib"
    return target_directory() / target / profile_directory(profile) / name


def missing_components(targets=TARGETS):
    """The rustup commands for what the pinned toolchain lacks: rust-src,
    which -Zbuild-std compiles std from, and each target's rust-std, whose
    self-contained wasi-libc and crt objects the link needs."""
    sysroot = subprocess.check_output(["rustc", "--print", "sysroot"], cwd=ENGINE, text=True)
    rustlib = Path(sysroot.strip()) / "lib/rustlib"
    missing = []
    if not (rustlib / "src/rust/library/Cargo.lock").exists():
        missing.append("rustup component add rust-src")
    absent = [target for target in targets if not (rustlib / target / "lib").is_dir()]
    if absent:
        missing.append("rustup target add " + " ".join(absent))
    return missing


def build(target, profile="release", shadow_stack=DEFAULT_SHADOW_STACK, extra_rustflags=(),
          crates=CRATES, locked=True, quiet=False):
    """Build the crates for one wasm target and return their libraries."""
    command = build_arguments(target, profile) + crate_arguments(crates)
    if locked:
        command.append("--locked")
    if quiet:
        command.append("--quiet")
    subprocess.run(command, cwd=ENGINE, env=environment(shadow_stack, extra_rustflags), check=True)
    paths = [artifact(crate, target, profile) for crate in crates]
    absent = [str(path) for path in paths if not path.exists()]
    if absent:
        raise SystemExit("the build produced no library at: " + ", ".join(absent))
    return paths


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target", action="append", choices=TARGETS,
                        help="a wasm target to build; repeatable (default: both)")
    parser.add_argument("--profile", default="release",
                        help="the cargo profile (default %(default)s)")
    parser.add_argument("--rustflags", default="",
                        help="extra RUSTFLAGS, one shell-quoted string, appended to the recipe's")
    parser.add_argument("--shadow-stack", type=int, default=DEFAULT_SHADOW_STACK,
                        help="the wasm shadow stack in bytes (default %(default)s)")
    parser.add_argument("--crate", action="append", choices=CRATES,
                        help="a crate to build; repeatable (default: all)")
    parser.add_argument("--no-locked", action="store_true", help="let cargo update Cargo.lock")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--print-env", action="store_true",
                        help="print the recipe as shell assignments (RUSTC_BOOTSTRAP, RUSTFLAGS, "
                             "BUILD_STD) instead of building, for a cargo command of your own")
    args = parser.parse_args()
    extra = shlex.split(args.rustflags)
    if args.print_env:
        env = environment(args.shadow_stack, extra, base={})
        for name in ("RUSTC_BOOTSTRAP", "RUSTFLAGS"):
            print(f"{name}={shlex.quote(env[name])}")
        print(f"BUILD_STD={shlex.quote(BUILD_STD)}")
        return
    targets = args.target or list(TARGETS)
    missing = missing_components(targets)
    if missing:
        raise SystemExit("the pinned toolchain lacks the recipe's components; from rust/engine run:\n  "
                         + "\n  ".join(missing))
    for target in targets:
        for path in build(target, args.profile, args.shadow_stack, extra, args.crate or CRATES,
                          locked=not args.no_locked, quiet=args.quiet):
            print(path)


if __name__ == "__main__":
    main()
