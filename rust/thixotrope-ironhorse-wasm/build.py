#!/usr/bin/env python3
"""Build the Thixotrope Ironhorse wasm worker module and verify its surface.

    python3 rust/thixotrope-ironhorse-wasm/build.py
    python3 rust/thixotrope-ironhorse-wasm/build.py --stage [DIR]

Builds `thixotrope-ironhorse-wasm` for wasm32-wasip1 under the engine's wasm
recipe (rust/engine/scripts/build-wasm.py, imported, never copied), locked
and release, from the repository's root workspace. Prints the module's path,
size and sha256, then parses the module's import and export sections and
fails unless both are exactly the lists below: a new WASI import (a file
call, a clock read) would otherwise surface only as a runtime error in the
host, which answers every name it does not provide with ENOSYS.

With `--stage`, it then builds the native launcher
(`thixotrope-ironhorse-wasm-launcher`, release, locked) and installs the
engine's four files side by side in DIR (default `target/thixotrope-ironhorse-wasm/`
under the repository): the launcher `thixotrope-ironhorse-wasm-worker`, the
Node shell as `thixotrope-ironhorse-wasm-shell.mjs`, `host-abi.mjs` and the
module. The launcher finds the other three beside itself by those names, so
pointing `THIXOTROPE_IRONHORSE_WORKER` at the staged launcher selects the
engine. Each file is written to a temporary name in DIR and renamed over its
final name, so a worker starting during a stage never reads a partial file.
"""
import argparse
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
TARGET = "wasm32-wasip1"
PACKAGE = "thixotrope-ironhorse-wasm"
MODULE = "thixotrope_ironhorse_wasm.wasm"

# The export ABI of src/lib.rs, and the linear memory.
EXPORTS = {
    ("memory", "memory"),
    ("ih_abi_version", "func"),
    ("ih_alloc", "func"),
    ("ih_free", "func"),
    ("ih_message_len", "func"),
    ("ih_message_copy", "func"),
    ("ih_open", "func"),
    ("ih_boot", "func"),
    ("ih_ready", "func"),
    ("ih_request", "func"),
    ("ih_close", "func"),
}

# The host imports, then what the standard library imports from WASI. The
# host-abi.mjs shim implements exactly these.
IMPORTS = {
    ("env", "host_exec"),
    ("env", "host_take"),
    ("env", "host_log"),
    ("env", "host_random"),
    ("wasi_snapshot_preview1", "fd_write"),
    ("wasi_snapshot_preview1", "random_get"),
    ("wasi_snapshot_preview1", "clock_time_get"),
    ("wasi_snapshot_preview1", "environ_get"),
    ("wasi_snapshot_preview1", "environ_sizes_get"),
    ("wasi_snapshot_preview1", "proc_exit"),
}

# The staged names, which the launcher's PARTS and the runtime's part
# hashing both rely on.
LAUNCHER_PACKAGE = "thixotrope-ironhorse-wasm-launcher"
LAUNCHER = "thixotrope-ironhorse-wasm-worker"
SHELL = "thixotrope-ironhorse-wasm-shell.mjs"
HOST_ABI = "host-abi.mjs"
WASM_SOURCES = ROOT / "packages/thixotrope/src/ironhorse/wasm"
DEFAULT_STAGE = ROOT / "target/thixotrope-ironhorse-wasm"

KINDS = {0: "func", 1: "table", 2: "memory", 3: "global", 4: "tag"}


def recipe():
    path = ROOT / "rust/engine/scripts/build-wasm.py"
    spec = importlib.util.spec_from_file_location("build_wasm", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def target_dir():
    configured = os.environ.get("CARGO_TARGET_DIR")
    target = Path(configured) if configured else Path("target")
    return target if target.is_absolute() else ROOT / target


def module_path():
    return target_dir() / TARGET / "release" / MODULE


class Reader:
    def __init__(self, data, at=0, end=None):
        self.data, self.at = data, at
        self.end = len(data) if end is None else end

    def byte(self):
        if self.at >= self.end:
            raise SystemExit("wasm: truncated module")
        value = self.data[self.at]
        self.at += 1
        return value

    def uleb(self):
        result, shift = 0, 0
        while True:
            byte = self.byte()
            result |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                return result

    def name(self):
        length = self.uleb()
        if self.at + length > self.end:
            raise SystemExit("wasm: truncated name")
        text = self.data[self.at:self.at + length].decode("utf-8")
        self.at += length
        return text

    def skip_limits(self):
        flags = self.byte()
        self.uleb()
        if flags & 1:
            self.uleb()

    def skip_import_type(self, kind):
        if kind == 0:  # func: a type index
            self.uleb()
        elif kind == 1:  # table: reftype, limits
            self.byte()
            self.skip_limits()
        elif kind == 2:  # memory: limits
            self.skip_limits()
        elif kind == 3:  # global: valtype, mutability
            self.byte()
            self.byte()
        elif kind == 4:  # tag: attribute, type index
            self.byte()
            self.uleb()
        else:
            raise SystemExit(f"wasm: unknown import kind {kind}")


def surface(data):
    """The module's (module, name) imports and (name, kind) exports."""
    if data[:8] != b"\0asm\1\0\0\0":
        raise SystemExit("wasm: not a version 1 module")
    reader = Reader(data, 8)
    imports, exports = set(), set()
    while reader.at < len(data):
        section = reader.byte()
        size = reader.uleb()
        body = Reader(data, reader.at, reader.at + size)
        if section == 2:
            for _ in range(body.uleb()):
                module, name, kind = body.name(), body.name(), body.byte()
                body.skip_import_type(kind)
                imports.add((module, name))
        elif section == 7:
            for _ in range(body.uleb()):
                name, kind = body.name(), body.byte()
                body.uleb()
                exports.add((name, KINDS.get(kind, f"kind {kind}")))
        reader.at += size
    return imports, exports


def differences(label, found, expected):
    lines = []
    for item in sorted(found - expected):
        lines.append(f"  unexpected {label}: {item}")
    for item in sorted(expected - found):
        lines.append(f"  missing {label}: {item}")
    return lines


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def install(source, directory, name, mode):
    """Copy `source` to `directory/name` through a temporary file in the
    same directory, synced before it is renamed over the final name."""
    final = directory / name
    temporary = directory / f".{name}.tmp-{os.getpid()}"
    try:
        with open(source, "rb") as reader, open(temporary, "wb") as writer:
            shutil.copyfileobj(reader, writer)
            writer.flush()
            os.fsync(writer.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, final)
    finally:
        temporary.unlink(missing_ok=True)
    return final


def stage(directory, module):
    command = ["cargo", "build", "--locked", "--release", "-p", LAUNCHER_PACKAGE]
    print(shlex.join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True)
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    files = [
        (target_dir() / "release" / LAUNCHER, LAUNCHER, 0o755),
        (WASM_SOURCES / "shell.mjs", SHELL, 0o644),
        (WASM_SOURCES / HOST_ABI, HOST_ABI, 0o644),
        (module, MODULE, 0o644),
    ]
    installed = [install(source, directory, name, mode) for source, name, mode in files]
    dirfd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dirfd)
    finally:
        os.close(dirfd)
    print(f"staged {directory}")
    for path in installed:
        print(f"  sha256 {sha256(path)}  {path.name}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stage", nargs="?", const=DEFAULT_STAGE, metavar="DIR",
                        help="also build the launcher and stage the engine in DIR "
                             "(default: target/thixotrope-ironhorse-wasm)")
    args = parser.parse_args()
    build = recipe()
    missing = build.missing_components([TARGET])
    if missing:
        raise SystemExit("the pinned toolchain lacks the recipe's components; from rust/engine run:\n  "
                         + "\n  ".join(missing))
    env = build.environment()
    command = build.build_arguments(TARGET) + ["--locked", "-p", PACKAGE]
    print("RUSTC_BOOTSTRAP=1 RUSTFLAGS=" + shlex.quote(env["RUSTFLAGS"]) + " "
          + shlex.join(command), flush=True)
    subprocess.run(command, cwd=ROOT, env=env, check=True)
    path = module_path()
    data = path.read_bytes()
    print(path)
    print(f"{len(data)} bytes")
    print(f"sha256 {hashlib.sha256(data).hexdigest()}")
    imports, exports = surface(data)
    problems = differences("import", imports, IMPORTS) + differences("export", exports, EXPORTS)
    if problems:
        print("the module's surface is not the checked-in one:", file=sys.stderr)
        print("\n".join(problems), file=sys.stderr)
        sys.exit(1)
    print(f"surface verified: {len(imports)} imports, {len(exports)} exports")
    for module, name in sorted(imports):
        print(f"  import {module}.{name}")
    for name, kind in sorted(exports):
        print(f"  export {name} ({kind})")
    if args.stage is not None:
        stage(args.stage, path)


if __name__ == "__main__":
    main()
