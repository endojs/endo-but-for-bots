#!/usr/bin/env python3
"""Profile compiler phases in an isolated copy after a scaling gate fails."""
from pathlib import Path
import os
import signal
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
PATCH = Path(__file__).with_name("profile-compile.patch")


def run_profile(command, cwd, env, timeout=600):
    # The compiler and benchmark descendants share a fresh process group.
    # A timed-out Cargo parent must not leave them running into later timings.
    process = subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True)
    try:
        return process.wait(timeout=timeout)
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        raise


def main():
    revision = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip()
    print(f"Compiler phase diagnostic for {revision}", flush=True)
    print("Timings include probe overhead; ordinary scaling gates remain authoritative.", flush=True)
    with tempfile.TemporaryDirectory(prefix="ironhorse-compile-profile-") as temp:
        archive = subprocess.check_output(
            ["git", "archive", revision, "rust/engine"], cwd=ROOT
        )
        subprocess.run(["tar", "-xf", "-", "-C", temp], input=archive, check=True)
        # git apply works outside a repository. Context mismatch fails closed;
        # the checkout used by later workflow steps is never modified.
        subprocess.run(
            ["git", "apply", "--check", str(PATCH)], cwd=temp, check=True
        )
        subprocess.run(["git", "apply", str(PATCH)], cwd=temp, check=True)
        engine = Path(temp) / "rust/engine"
        print(subprocess.check_output(["rustc", "--version"], cwd=engine, text=True), flush=True)
        env = dict(os.environ, CARGO_INCREMENTAL="0", CARGO_TARGET_DIR=str(Path(temp) / "target"))
        env.setdefault("RUST_MIN_STACK", "33554432")
        return run_profile(
            [
                "cargo", "test", "--manifest-path", "Cargo.toml",
                "--locked", "--release", "-p", "ironhorse-compile",
                "--test", "compile_budget_bench", "--", "--ignored",
                "--nocapture", "--test-threads=1",
            ],
            cwd=engine,
            env=env,
            timeout=600,
        )


if __name__ == "__main__":
    raise SystemExit(main())
