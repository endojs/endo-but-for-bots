#!/usr/bin/env python3
"""The wasm Thixotrope worker spike: build the engine as an unwinding wasm
module, serve it from a SQLite-backed Durable Object in local workerd, and
run the store acceptance suite and the design's Phase 0 measurements against
it. See README.md.

  python3 run.py build
  python3 run.py [options] suite [--parts sparse,metamorphic,...] [--no-tx]
  python3 run.py [options] boot --boot FILE [--boot FILE ...] [--wakes N] [--idle S]
  python3 run.py [options] wake --container FILE --profile P [--wakes N] [--idle S]
  python3 run.py [options] sweep [--wakes N]
  python3 run.py [options] export --store ID --out FILE

The options go before the subcommand: --no-build reuses the last module,
--json FILE saves the records it prints, --keep DIR keeps workerd's
directory. Needs the `workerd` binary ($WORKERD, or `workerd` on PATH) and
the pinned Rust with rust-src and the wasm32-wasip1 target.
"""
import argparse
import http.client
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.parse

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parent
# wasm32-wasip1 rather than wasm32-unknown-unknown: the acceptance suite's own
# sessions draw commit tokens from the engine's default source, which needs a
# clock and seeded hash keys (WASI has both; the other target has neither and
# the engine refuses there). The sessions the spike owns draw from the host's
# randomness on either target. The host shims the handful of WASI imports std
# reaches for (host/worker.js).
WASM_TARGET = "wasm32-wasip1"
MODULE = HERE / "target" / WASM_TARGET / "release/ih_wasm_worker_spike.wasm"
SHADOW_STACK = 4 * 1024 * 1024


def official_recipe():
    """The engine's wasm build recipe, imported from its one home,
    `scripts/build-wasm.py` (a hyphenated name, so loaded by path)."""
    path = ENGINE / "scripts/build-wasm.py"
    spec = importlib.util.spec_from_file_location("build_wasm", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
DEFAULT_PARTS = ["sparse", "checkpoint", "resume", "commit", "edits", "lazy", "boundary", "metamorphic"]


def build(quiet=False):
    """The engine's official wasm recipe (`scripts/build-wasm.py`: std rebuilt
    with unwinding under RUSTC_BOOTSTRAP, exnref exception handling, a 4 MiB
    shadow stack), applied to the spike's cdylib for wasm32-wasip1."""
    recipe = official_recipe()
    missing = recipe.missing_components([WASM_TARGET])
    if missing:
        raise SystemExit("the toolchain lacks what the link needs; run from rust/engine:\n  " + "\n  ".join(missing))
    shutil.copyfile(ENGINE / "Cargo.lock", HERE / "Cargo.lock")
    env = recipe.environment(SHADOW_STACK)
    env["CARGO_INCREMENTAL"] = "0"
    env["CARGO_TARGET_DIR"] = str(HERE / "target")
    command = recipe.build_arguments(WASM_TARGET)
    if quiet:
        command.append("--quiet")
    subprocess.run(command, cwd=HERE, env=env, check=True)
    if not MODULE.exists():
        raise SystemExit(f"build produced no module at {MODULE}")
    return MODULE


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Workerd:
    """One workerd process serving the spike with local-disk DO storage."""

    def __init__(self, binary, module, v8_flags=(), keep=None):
        self.dir = Path(keep) if keep else Path(tempfile.mkdtemp(prefix="ih-spike-workerd-"))
        self.keep = keep is not None
        self.process = None
        self.log = None
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            (self.dir / "disk").mkdir(exist_ok=True)
            self.port = free_port()
            address = f"127.0.0.1:{self.port}"
            config = (HERE / "host/config.capnp.in").read_text()
            config = config.replace("@ADDRESS@", address)
            config = config.replace("@DISK@", json.dumps(str(self.dir / "disk"), ensure_ascii=False)[1:-1])
            config = config.replace("@V8_FLAGS@", ", ".join(json.dumps(f) for f in v8_flags))
            (self.dir / "config.capnp").write_text(config)
            shutil.copyfile(HERE / "host/worker.js", self.dir / "worker.js")
            shutil.copyfile(module, self.dir / "spike.wasm")
            self.log = open(self.dir / "workerd.log", "w")
            self.process = subprocess.Popen(
                [str(binary), "serve", "--experimental", str(self.dir / "config.capnp")],
                stdout=self.log,
                stderr=subprocess.STDOUT,
            )
        except OSError:
            self.close()
            raise
        deadline = time.time() + 30
        while time.time() < deadline:
            if self.process.poll() is not None:
                self.log.close()
                raise SystemExit(f"workerd exited early; see {self.dir / 'workerd.log'}")
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.5):
                    return
            except OSError:
                time.sleep(0.1)
        self.close()
        raise SystemExit("workerd did not start listening")

    def request(self, method, path, params=None, body=None, timeout=3600):
        query = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None})
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        conn.request(method, f"{path}?{query}" if query else path, body=body)
        response = conn.getresponse()
        data = response.read()
        conn.close()
        kind = response.getheader("content-type", "")
        if kind.startswith("application/json"):
            payload = json.loads(data)
        elif kind.startswith("application/octet-stream"):
            payload = data
        else:
            raise SystemExit(f"{method} {path}: {response.status} {kind}: {data[:500]!r}")
        return response.status, payload

    def get(self, path, **params):
        return self.request("GET", path, params)

    def post(self, path, body, **params):
        return self.request("POST", path, params, body)

    def close(self):
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
        if self.log is not None:
            self.log.close()
        if not self.keep:
            shutil.rmtree(self.dir, ignore_errors=True)


def workerd_binary():
    return os.environ.get("WORKERD", "workerd")


JSON_OUT = None


def emit(records, record):
    """Keep, print and (with --json) save one record at once, so a failure
    later in the run loses nothing measured before it."""
    records.append(record)
    line = json.dumps(record)
    print(line, flush=True)
    if JSON_OUT is not None:
        JSON_OUT.write(line + "\n")
        JSON_OUT.flush()


def idle(seconds):
    """Let local workerd evict the object (it does after about ten idle
    seconds), so the next request re-runs the constructor and reopens the
    database: a cold wake rather than an instance swap."""
    if seconds:
        time.sleep(seconds)


def cold_wake(wd, records, label, store, profile, lazy, crank_source, budget, slots, chunk, idle_seconds):
    """Drop the session and the instance, optionally let the object idle
    out, then instantiate, resume, run one crank and commit it."""
    wd.get("/session/drop")
    wd.get("/instance/drop")
    idle(idle_seconds)
    # The object's age on this first request after the idle: near zero means
    # the request constructed it afresh, so the wake is an evicted object's,
    # and the request's own wall time (client side) is then the object's
    # construction and database open on top of a warm request's.
    t0 = time.perf_counter()
    status, before = wd.get("/memory")
    first_request_ms = round((time.perf_counter() - t0) * 1000, 1)
    status, ensure = wd.get("/instance/ensure")
    status, resume = wd.get("/session/resume", store=store, lazy=1 if lazy else 0, profile=profile, slots=slots, chunk=chunk)
    status, stats_before = wd.get("/session/stats")
    status, crank = wd.post("/crank", crank_source.encode(), budget=budget)
    status, stats_after = wd.get("/session/stats")
    status, memory = wd.get("/memory")
    record = {
        "measure": "wake",
        "label": label,
        "lazy": lazy,
        "idle_s": idle_seconds,
        "object_age_ms": before.get("objectAgeMs"),
        "object_evicted": bool(idle_seconds) and (before.get("objectAgeMs") or 0) < idle_seconds * 1000,
        "object_first_request_ms": first_request_ms,
        "instantiate_ms": ensure.get("instantiateMs"),
        "memory_after_instantiate": ensure.get("memory"),
        "resume_ms": resume.get("ms"),
        "resume_status": resume.get("status"),
        "resume_message": resume.get("message") if resume.get("status") else "",
        "resume_rows_read": resume.get("rowsRead"),
        "resume_execs": resume.get("execs"),
        "memory_after_resume": resume.get("memory"),
        "resident_pages_after_resume": (stats_before.get("stats") or {}).get("resident_pages"),
        "total_pages": (stats_before.get("stats") or {}).get("total_pages"),
        "crank_ok": crank.get("ok"),
        "crank_error": crank.get("error"),
        "eval_ms": (crank.get("eval") or {}).get("ms"),
        "eval_result": (crank.get("eval") or {}).get("message"),
        "eval_rows_read": (crank.get("eval") or {}).get("rowsRead"),
        "checkpoint_ms": (crank.get("checkpoint") or {}).get("ms"),
        "checkpoint_rows_read": (crank.get("checkpoint") or {}).get("rowsRead"),
        "checkpoint_rows_written": (crank.get("checkpoint") or {}).get("rowsWritten"),
        "checkpoint_execs": (crank.get("checkpoint") or {}).get("execs"),
        "sync_ms": crank.get("syncMs"),
        "crank_total_ms": crank.get("totalMs"),
        "resident_pages_after_crank": (stats_after.get("stats") or {}).get("resident_pages"),
        "memory_after_crank": memory.get("memory"),
        "host_log": host_log(resume, crank, crank.get("eval"), crank.get("checkpoint")),
    }
    emit(records, record)
    return record


def host_log(*results):
    """The host's diagnostic lines from these results (a WASI import the shim
    does not provide, a panic's text), from a successful export's `log` or a
    failed route's `detail.log`, so they reach the records."""
    lines = []
    for result in results:
        if not result:
            continue
        lines.extend(result.get("log") or [])
        lines.extend((result.get("detail") or {}).get("log") or [])
    return lines


def wake_failed(record):
    return record.get("resume_status") != 0 or not record.get("crank_ok")


def cmd_suite(args, wd, records):
    failures = 0
    for part in args.parts:
        status, result = wd.get("/suite", name=part, tx=0 if args.no_tx else 1)
        record = {
            "measure": "suite",
            "part": part,
            "http": status,
            "status": result.get("status"),
            "ms": result.get("ms"),
            "rows_read": result.get("rowsRead"),
            "rows_written": result.get("rowsWritten"),
            "execs": result.get("execs"),
            "sync_ms": result.get("syncMs"),
            "memory": result.get("memory"),
            "message": result.get("message"),
            "error": result.get("error"),
            "host_log": host_log(result),
        }
        emit(records, record)
        if status != 200 or result.get("status") != 0:
            failures += 1
    return failures


def cmd_boot(args, wd, records):
    """First boot inside the Durable Object: a fresh machine, each boot file
    as one crank with the worker's boot budget, then cold wakes."""
    profile = args.profile
    wd.get("/instance/drop")
    status, ensure = wd.get("/instance/ensure")
    status, begin = wd.get("/session/begin", store=args.store, profile=profile, slots=args.slots, chunk=args.chunk)
    emit(records, {"measure": "begin", "instantiate_ms": ensure.get("instantiateMs"), **{k: begin.get(k) for k in ("status", "ms", "message", "memory")}, "sync_ms": begin.get("syncMs"), "error": begin.get("error"), "host_log": host_log(begin)})
    if begin.get("status") != 0:
        return 1
    for path in args.boot:
        source = Path(path).read_bytes()
        status, crank = wd.post("/crank", source, budget=1_000_000_000)
        emit(records, {
            "measure": "boot-crank",
            "file": str(path),
            "source_bytes": len(source),
            "ok": crank.get("ok"),
            "error": crank.get("error"),
            "eval_ms": (crank.get("eval") or {}).get("ms"),
            "checkpoint_ms": (crank.get("checkpoint") or {}).get("ms"),
            "checkpoint_rows_written": (crank.get("checkpoint") or {}).get("rowsWritten"),
            "checkpoint_execs": (crank.get("checkpoint") or {}).get("execs"),
            "memory": (crank.get("checkpoint") or crank.get("eval") or {}).get("memory"),
            "sync_ms": crank.get("syncMs"),
            "total_ms": crank.get("totalMs"),
            "host_log": host_log(crank, crank.get("eval"), crank.get("checkpoint")),
        })
        if not crank.get("ok"):
            return 1
    status, stats = wd.get("/session/stats")
    emit(records, {"measure": "booted", **(stats.get("stats") or {})})
    failed = 0
    for lazy in (True, False):
        for n in range(args.wakes):
            record = cold_wake(wd, records, f"boot-wake-{n}", args.store, profile, lazy, args.crank, args.budget, args.slots, args.chunk, args.idle)
            failed += wake_failed(record)
    return failed


def cmd_wake(args, wd, records):
    """Import a container, then cold wakes, lazy and eager."""
    container = Path(args.container).read_bytes()
    wd.get("/instance/drop")
    status, ensure = wd.get("/instance/ensure")
    status, imported = wd.post("/import", container, store=args.store, profile=args.profile)
    emit(records, {
        "measure": "import",
        "container_bytes": len(container),
        "instantiate_ms": ensure.get("instantiateMs"),
        "memory_before": ensure.get("memory"),
        **{k: imported.get(k) for k in ("status", "ms", "message", "execs", "memory")},
        "rows_written": imported.get("rowsWritten"),
        "sync_ms": imported.get("syncMs"),
        "error": imported.get("error"),
        "host_log": host_log(imported),
    })
    if imported.get("status") != 0:
        return 1
    failed = 0
    for lazy in (True, False):
        for n in range(args.wakes):
            record = cold_wake(wd, records, f"wake-{n}", args.store, args.profile, lazy, args.crank, args.budget, args.slots, args.chunk, args.idle)
            failed += wake_failed(record)
    return failed


SWEEP = {
    "objects-50k": "var keep = []; var i = 0; for (i = 0; i < 50000; i = i + 1) { keep.push({ v: i, w: 'x' + i }); } keep.length",
    "array-500k": "var keep = []; var i = 0; for (i = 0; i < 500000; i = i + 1) { keep.push(i); } keep.length",
    "map-100k": "var keep = new Map(); var i = 0; for (i = 0; i < 100000; i = i + 1) { keep.set(i, i); } keep.size",
    "strings-16m": "var keep = []; var s = 'abcdefgh'; var i = 0; for (i = 0; i < 21; i = i + 1) { s = s + s; } for (i = 0; i < 1; i = i + 1) { keep.push(s); } keep.length",
    "closures-20k": "var keep = []; var i = 0; for (i = 0; i < 20000; i = i + 1) { keep.push((function (n) { return function () { return n; }; })(i)); } keep.length",
}


def cmd_sweep(args, wd, records):
    """Synthetic heaps: one builder crank each on a fresh store, then cold wakes."""
    failed = 0
    for n, (name, source) in enumerate(SWEEP.items()):
        if args.only and name not in args.only:
            continue
        store = 100 + n
        wd.get("/instance/drop")
        wd.get("/instance/ensure")
        status, begin = wd.get("/session/begin", store=store, profile=args.profile, slots=args.slots, chunk=args.chunk)
        status, crank = wd.post("/crank", source.encode(), budget=1_000_000_000)
        status, stats = wd.get("/session/stats")
        emit(records, {
            "measure": "sweep-build",
            "heap": name,
            "begin_status": begin.get("status"),
            "begin_message": begin.get("message") or begin.get("error"),
            "ok": crank.get("ok"),
            "error": crank.get("error"),
            "result": (crank.get("eval") or {}).get("message"),
            "eval_ms": (crank.get("eval") or {}).get("ms"),
            "checkpoint_ms": (crank.get("checkpoint") or {}).get("ms"),
            "checkpoint_rows_written": (crank.get("checkpoint") or {}).get("rowsWritten"),
            "memory_after_eval": (crank.get("eval") or {}).get("memory"),
            "memory_after_checkpoint": (crank.get("checkpoint") or {}).get("memory"),
            "sync_ms": crank.get("syncMs"),
            "host_log": host_log(begin, crank, crank.get("eval"), crank.get("checkpoint")),
            **{k: (stats.get("stats") or {}).get(k) for k in ("slot_count", "chunk_len", "total_pages")},
        })
        if not crank.get("ok"):
            failed += 1
            continue
        for lazy in (True, False):
            for k in range(args.wakes):
                record = cold_wake(wd, records, f"{name}-wake-{k}", store, args.profile, lazy, args.crank, args.budget, args.slots, args.chunk, args.idle)
                failed += wake_failed(record)
    return failed


def cmd_export(args, wd, records):
    wd.get("/instance/ensure")
    status, payload = wd.get("/export", store=args.store)
    if status != 200:
        print(json.dumps(payload))
        return 1
    Path(args.out).write_bytes(payload)
    emit(records, {"measure": "export", "store": args.store, "bytes": len(payload), "out": args.out})
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--no-build", action="store_true")
    parser.add_argument("--json", help="save the records to this file")
    parser.add_argument("--keep", help="keep workerd's directory here (config, disk, log)")
    parser.add_argument("--v8-flags", default="", help="comma-separated V8 flags for workerd")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("build")
    p = sub.add_parser("suite")
    p.add_argument("--parts", default=",".join(DEFAULT_PARTS))
    p.add_argument("--no-tx", action="store_true", help="run each part outside its own transactionSync (the handler's implicit transaction still commits at the output gate; this removes only the savepoint and the rollback)")
    for name in ("boot", "wake", "sweep"):
        p = sub.add_parser(name)
        p.add_argument("--profile", default="spike")
        p.add_argument("--store", type=int, default=1)
        p.add_argument("--wakes", type=int, default=3)
        p.add_argument("--idle", type=float, default=0, help="seconds to idle before each wake")
        p.add_argument("--slots", type=int, default=0, help="slot ceiling (0: engine default)")
        p.add_argument("--chunk", type=int, default=0, help="chunk ceiling in bytes (0: engine default)")
        p.add_argument("--crank", default="1 + 1", help="the source of the wake's crank")
        p.add_argument("--budget", type=int, default=10_000_000)
        if name == "boot":
            p.add_argument("--boot", action="append", required=True, help="a boot file (repeatable)")
        if name == "wake":
            p.add_argument("--container", required=True)
        if name == "sweep":
            p.add_argument("--only", action="append")
    p = sub.add_parser("export")
    p.add_argument("--store", type=int, default=1)
    p.add_argument("--out", required=True)
    args = parser.parse_args()
    if args.command == "build":
        print(build())
        return
    module = MODULE if args.no_build else build(quiet=True)
    if args.command == "suite":
        args.parts = [p for p in args.parts.split(",") if p]
    flags = [f for f in args.v8_flags.split(",") if f]
    records = []
    global JSON_OUT
    if args.json:
        JSON_OUT = open(args.json, "w")
    wd = Workerd(workerd_binary(), module, flags, keep=args.keep)
    try:
        failures = {"suite": cmd_suite, "boot": cmd_boot, "wake": cmd_wake, "sweep": cmd_sweep, "export": cmd_export}[args.command](args, wd, records)
    finally:
        wd.close()
        if JSON_OUT is not None:
            JSON_OUT.close()
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
