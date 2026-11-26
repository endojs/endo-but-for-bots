#!/usr/bin/env python3
"""The workerd harness for the product crates: build the harness module (the
product `DoStore` and `Worker` behind the harness's exports, with the store
acceptance suite) as an unwinding wasm module, serve it from a SQLite-backed
Durable Object in local workerd, and run the suite and the measurements
against it; or serve the product module itself through the real
`host-abi.mjs`. See README.md.

  python3 run.py build
  python3 run.py [options] suite [--parts sparse,metamorphic,...] [--no-tx]
  python3 run.py [options] boot --boot FILE [--boot FILE ...] [--wakes N] [--idle S]
  python3 run.py [options] wake --container FILE --profile P [--wakes N] [--idle S]
  python3 run.py [options] sweep [--wakes N]
  python3 run.py [options] export --store ID --out FILE
  python3 run.py [options] product [--module FILE] [--boot FILE ...] [--wakes N] [--evict abort|idle]

The options go before the subcommand: --no-build reuses the last module,
--json FILE saves the records it prints, --keep DIR keeps workerd's
directory. Needs the `workerd` binary ($WORKERD, or `workerd` on PATH) and
the pinned Rust with rust-src and the wasm32-wasip1 target.
"""
import argparse
import gzip
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
ROOT = ENGINE.parent.parent
# wasm32-wasip1, the product module's target: the acceptance suite's own
# sessions draw commit tokens from the engine's default source, which needs
# a clock and seeded hash keys (WASI has both; wasm32-unknown-unknown has
# neither and the engine refuses there). The workers the harness opens draw
# from the host's randomness, as the product module's do. The host shims the
# handful of WASI imports std reaches for (host/worker.js).
WASM_TARGET = "wasm32-wasip1"
MODULE = HERE / "target" / WASM_TARGET / "release/ih_wasm_worker_spike.wasm"
PRODUCT_MODULE = ROOT / "target" / WASM_TARGET / "release/thixotrope_ironhorse_wasm.wasm"
HOST_ABI = ROOT / "packages/thixotrope/src/ironhorse/wasm/host-abi.mjs"
BOOT_DIR = ROOT / "packages/thixotrope/dist-ironhorse"
SHADOW_STACK = 4 * 1024 * 1024
# The product host's default limits (makeIronhorseLimits), which are the
# engine's default ceilings.
CRANK_BUDGET = 10_000_000
BOOT_BUDGET = 1_000_000_000
SLOT_CEILING = 1_000_000
CHUNK_CEILING = 268_435_456


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
    shadow stack), applied to the harness's cdylib for wasm32-wasip1."""
    recipe = official_recipe()
    missing = recipe.missing_components([WASM_TARGET])
    if missing:
        raise SystemExit("the toolchain lacks what the link needs; run from rust/engine:\n  " + "\n  ".join(missing))
    # The lock is the repository root's, not the engine's: the harness links
    # `thixotrope-ironhorse-core`, a root-workspace member that brings
    # `serde_json` and its dependencies, which the engine's lock does not
    # resolve; and the root lock is the one the product module is built from
    # (`build.py` builds it there with --locked), so the harness resolves
    # every crate to the version the product links. The two locks agree on
    # everything they share (`scripts/check-lockfile-agreement.py`), so the
    # engine crates resolve as the engine's own builds resolve them. Cargo
    # drops the root workspace's other packages from the copy on its first
    # resolution, which is why the build cannot be --locked.
    shutil.copyfile(ROOT / "Cargo.lock", HERE / "Cargo.lock")
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


def capnp_string(text):
    """`text` inside a Cap'n Proto string literal."""
    return json.dumps(str(text), ensure_ascii=False)[1:-1]


class Workerd:
    """One workerd process with local-disk DO storage: the harness module
    (`product` false) or the product module (`product` a module path)."""

    def __init__(self, binary, module, v8_flags=(), keep=None, product=None):
        self.dir = Path(keep) if keep else Path(tempfile.mkdtemp(prefix="ih-spike-workerd-"))
        self.keep = keep is not None
        self.process = None
        self.log = None
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            (self.dir / "disk").mkdir(exist_ok=True)
            self.port = free_port()
            address = f"127.0.0.1:{self.port}"
            template = "host/product.capnp.in" if product else "host/config.capnp.in"
            config = (HERE / template).read_text()
            config = config.replace("@ADDRESS@", address)
            config = config.replace("@DISK@", capnp_string(self.dir / "disk"))
            config = config.replace("@V8_FLAGS@", ", ".join(json.dumps(f) for f in v8_flags))
            if product:
                # Embedded from where they live. workerd resolves an embed
                # path against the config file's directory and does not read
                # an absolute one, so each is relative to that directory.
                def embed(path):
                    return capnp_string(os.path.relpath(Path(path).resolve(), self.dir.resolve()))
                config = config.replace("@PRODUCT_JS@", embed(HERE / "host/product.js"))
                config = config.replace("@HOST_ABI@", embed(HOST_ABI))
                config = config.replace("@PRODUCT_WASM@", embed(product))
            else:
                shutil.copyfile(HERE / "host/worker.js", self.dir / "worker.js")
                shutil.copyfile(module, self.dir / "spike.wasm")
            (self.dir / "config.capnp").write_text(config)
            self.log = open(self.dir / "workerd.log", "w")
            started = time.perf_counter()
            self.process = subprocess.Popen(
                [str(binary), "serve", "--experimental", str(self.dir / "config.capnp")],
                stdout=self.log,
                stderr=subprocess.STDOUT,
            )
        except OSError:
            self.close()
            raise
        deadline = time.time() + 60
        while time.time() < deadline:
            if self.process.poll() is not None:
                self.log.close()
                raise SystemExit(f"workerd exited early; see {self.dir / 'workerd.log'}")
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.5):
                    # Polled at 50 ms, so a bound on workerd's start (its
                    # config and the worker's modules loaded), not a
                    # measure of compiling the wasm.
                    self.start_ms = round((time.perf_counter() - started) * 1000, 1)
                    return
            except OSError:
                time.sleep(0.05)
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
            payload = {"error": f"{response.status} {kind}: {data[:500]!r}"}
        return response.status, payload

    def get(self, path, **params):
        return self.request("GET", path, params)

    def post(self, path, body, **params):
        return self.request("POST", path, params, body)

    def log_text(self):
        try:
            return (self.dir / "workerd.log").read_text(errors="replace")
        except OSError:
            return ""

    def close(self):
        if self.process is not None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
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


def limits_json(args, crank_budget=None):
    return json.dumps({
        "crankBudget": str(crank_budget or args.budget),
        "bootstrapBudget": str(BOOT_BUDGET),
        "slotCeiling": args.slots,
        "chunkCeiling": args.chunk,
    })


def request_line(source, budget=None):
    request = {"source": source}
    if budget is not None:
        request["budget"] = str(budget)
    return json.dumps(request)


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


def summed(*values):
    """The sum of these figures, or None when any is missing."""
    if any(v is None for v in values):
        return None
    return round(sum(values), 1)


def cold_wake(wd, records, label, args, store, lazy):
    """Drop the worker and the instance, optionally let the object idle out,
    then instantiate, resume, answer one request and close."""
    wd.get("/session/drop")
    wd.get("/instance/drop")
    idle(args.idle)
    # The object's age on this first request after the idle: near zero means
    # the request constructed it afresh, so the wake is an evicted object's,
    # and the request's own wall time (client side) is then the object's
    # construction and database open on top of a warm request's.
    t0 = time.perf_counter()
    status, before = wd.get("/memory")
    first_request_ms = round((time.perf_counter() - t0) * 1000, 1)
    limits = limits_json(args)
    status, ensure = wd.get("/instance/ensure")
    status, resume = wd.get("/session/resume", store=store, lazy=1 if lazy else 0, profile=args.profile, limits=limits)
    status, stats_before = wd.get("/session/stats")
    status, reply = wd.post("/session/request", request_line(args.crank, args.budget).encode())
    status, stats_after = wd.get("/session/stats")
    status, close = wd.get("/session/close")
    status, memory = wd.get("/memory")
    record = {
        "measure": "wake",
        "label": label,
        "lazy": lazy,
        "idle_s": args.idle,
        "object_age_ms": before.get("objectAgeMs"),
        "object_evicted": bool(args.idle) and (before.get("objectAgeMs") or 0) < args.idle * 1000,
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
        "request_status": reply.get("status"),
        "request_reply": reply.get("message"),
        "request_error": reply.get("error"),
        "request_ms": reply.get("ms"),
        "request_rows_read": reply.get("rowsRead"),
        "request_rows_written": reply.get("rowsWritten"),
        "request_execs": reply.get("execs"),
        "resident_pages_after_request": (stats_after.get("stats") or {}).get("resident_pages"),
        "memory_after_request": reply.get("memory"),
        "wake_to_reply_ms": summed(ensure.get("instantiateMs"), resume.get("ms"), reply.get("ms")),
        "close_status": close.get("status"),
        "close_message": close.get("message") if close.get("status") else "",
        "close_epoch": close.get("message") if close.get("status") == 0 else None,
        "close_ms": close.get("ms"),
        "close_rows_read": close.get("rowsRead"),
        "close_rows_written": close.get("rowsWritten"),
        "close_execs": close.get("execs"),
        "sync_ms": close.get("syncMs"),
        "memory_after_close": memory.get("memory"),
        "host_log": host_log(resume, reply, close),
    }
    emit(records, record)
    return record


def wake_failed(record):
    return record.get("resume_status") != 0 or record.get("request_status") != 0 or record.get("close_status") != 0


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
    """First boot inside the Durable Object: `Worker::begin` on a clean
    store (which commits the bare machine), each boot file through
    `Worker::boot` under the bootstrap budget, uncommitted, then one
    checkpoint of the booted heap (the product's ready commit), then cold
    wakes."""
    wd.get("/instance/drop")
    status, ensure = wd.get("/instance/ensure")
    status, begin = wd.get("/session/begin", store=args.store, profile=args.profile, limits=limits_json(args))
    emit(records, {
        "measure": "begin",
        "instantiate_ms": ensure.get("instantiateMs"),
        **{k: begin.get(k) for k in ("status", "ms", "message", "memory", "execs")},
        "rows_written": begin.get("rowsWritten"),
        "sync_ms": begin.get("syncMs"),
        "error": begin.get("error"),
        "host_log": host_log(begin),
    })
    if begin.get("status") != 0:
        return 1
    for path in args.boot:
        source = Path(path).read_bytes()
        status, booted = wd.post("/session/boot", source, name=Path(path).name)
        emit(records, {
            "measure": "boot-file",
            "file": str(path),
            "source_bytes": len(source),
            "status": booted.get("status"),
            "message": booted.get("message") or booted.get("error"),
            "boot_ms": booted.get("ms"),
            "rows_written": booted.get("rowsWritten"),
            "memory": booted.get("memory"),
            "host_log": host_log(booted),
        })
        if booted.get("status") != 0:
            return 1
    status, checkpoint = wd.get("/session/checkpoint")
    emit(records, {
        "measure": "boot-checkpoint",
        "status": checkpoint.get("status"),
        "epoch": checkpoint.get("message") if checkpoint.get("status") == 0 else None,
        "message": checkpoint.get("message") if checkpoint.get("status") else (checkpoint.get("error") or ""),
        "checkpoint_ms": checkpoint.get("ms"),
        "rows_read": checkpoint.get("rowsRead"),
        "rows_written": checkpoint.get("rowsWritten"),
        "execs": checkpoint.get("execs"),
        "memory": checkpoint.get("memory"),
        "sync_ms": checkpoint.get("syncMs"),
        "host_log": host_log(checkpoint),
    })
    if checkpoint.get("status") != 0:
        return 1
    status, stats = wd.get("/session/stats")
    emit(records, {"measure": "booted", **(stats.get("stats") or {})})
    failed = 0
    for lazy in (True, False):
        for n in range(args.wakes):
            failed += wake_failed(cold_wake(wd, records, f"boot-wake-{n}", args, args.store, lazy))
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
            failed += wake_failed(cold_wake(wd, records, f"wake-{n}", args, args.store, lazy))
    return failed


SWEEP = {
    "objects-50k": "var keep = []; var i = 0; for (i = 0; i < 50000; i = i + 1) { keep.push({ v: i, w: 'x' + i }); } keep.length",
    "array-500k": "var keep = []; var i = 0; for (i = 0; i < 500000; i = i + 1) { keep.push(i); } keep.length",
    "map-100k": "var keep = new Map(); var i = 0; for (i = 0; i < 100000; i = i + 1) { keep.set(i, i); } keep.size",
    "strings-16m": "var keep = []; var s = 'abcdefgh'; var i = 0; for (i = 0; i < 21; i = i + 1) { s = s + s; } for (i = 0; i < 1; i = i + 1) { keep.push(s); } keep.length",
    "closures-20k": "var keep = []; var i = 0; for (i = 0; i < 20000; i = i + 1) { keep.push((function (n) { return function () { return n; }; })(i)); } keep.length",
}


def cmd_sweep(args, wd, records):
    """Synthetic heaps: one builder request each on a fresh store, then its
    commit (`Worker::checkpoint`, the commit `Worker::close` makes, taken
    before the close so that the stats read the committed manifest), then
    cold wakes."""
    failed = 0
    for n, (name, source) in enumerate(SWEEP.items()):
        if args.only and name not in args.only:
            continue
        store = 100 + n
        wd.get("/instance/drop")
        wd.get("/instance/ensure")
        status, begin = wd.get("/session/begin", store=store, profile=args.profile, limits=limits_json(args))
        status, reply = wd.post("/session/request", request_line(source, BOOT_BUDGET).encode())
        status, commit = wd.get("/session/checkpoint")
        status, stats = wd.get("/session/stats")
        wd.get("/session/drop")
        emit(records, {
            "measure": "sweep-build",
            "heap": name,
            "begin_status": begin.get("status"),
            "begin_message": begin.get("message") or begin.get("error"),
            "request_status": reply.get("status"),
            "reply": reply.get("message") or reply.get("error"),
            "request_ms": reply.get("ms"),
            "memory_after_request": reply.get("memory"),
            "commit_status": commit.get("status"),
            "commit_message": commit.get("message") if commit.get("status") else "",
            "commit_ms": commit.get("ms"),
            "commit_rows_written": commit.get("rowsWritten"),
            "memory_after_commit": commit.get("memory"),
            "sync_ms": commit.get("syncMs"),
            "host_log": host_log(begin, reply, commit),
            **{k: (stats.get("stats") or {}).get(k) for k in ("slot_count", "chunk_len", "total_pages")},
        })
        if reply.get("status") != 0 or commit.get("status") != 0:
            failed += 1
            continue
        for lazy in (True, False):
            for k in range(args.wakes):
                failed += wake_failed(cold_wake(wd, records, f"{name}-wake-{k}", args, store, lazy))
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


# The product command's requests, as the Node test of the module drives them.
PRODUCT_FRAME = {"t": "f", "b64": "AAEC"}
PRODUCT_REQUESTS = [
    ("eval", json.dumps({"source": "globalThis.kept = 41; kept + 1"})),
    ("deliver", json.dumps({
        "op": "deliver",
        "source": f"thixotropeSend({json.dumps(json.dumps(PRODUCT_FRAME))}); kept",
        "drainBudget": "1000000",
    })),
    ("malformed", '{"source":'),
    ("close-request", json.dumps({"op": "close"})),
]
READY_LINE = '{"features":["deliver-v1"],"op":"ready"}\n'


def reply_of(value):
    return json.dumps({"op": "result", "result": value}, separators=(",", ":")) + "\n"


class Product:
    """The product command's client: one call per route, each answer kept
    as a record and checked against what the ABI says it must be."""

    def __init__(self, wd, records, args):
        self.wd, self.records, self.args = wd, records, args
        self.failures = []

    def call(self, step, route, body=None, **params):
        t0 = time.perf_counter()
        if body is None:
            status, answer = self.wd.get(route, **params)
        else:
            status, answer = self.wd.post(route, body.encode() if isinstance(body, str) else body, **params)
        wall_ms = round((time.perf_counter() - t0) * 1000, 1)
        record = {"measure": "product-call", "step": step, "route": route, "http": status, "wall_ms": wall_ms}
        for key in ("kind", "status", "message", "trap", "committed", "forcedRollback", "dropped", "ms", "syncMs",
                    "execs", "rowsRead", "rowsWritten", "bytesBound", "bytesReturned", "memory", "log", "error",
                    "name", "sourceBytes"):
            if key in answer:
                record[key] = answer[key]
        emit(self.records, record)
        return answer

    def expect(self, step, condition, detail):
        if not condition:
            self.failures.append(f"{step}: {detail}")
            emit(self.records, {"measure": "product-check", "step": step, "ok": False, "detail": detail})
        return condition

    def answer(self, step, route, status, message=None, committed=None, body=None, **params):
        """A call whose status (and message, and commit) the ABI fixes."""
        answer = self.call(step, route, body, **params)
        self.expect(step, answer.get("status") == status, f"status {answer.get('status')!r}, not {status}: {answer}")
        if message is not None:
            ok = message(answer.get("message")) if callable(message) else answer.get("message") == message
            self.expect(step, ok, f"message {answer.get('message')!r}")
        if committed is not None:
            self.expect(step, answer.get("committed") == committed, f"committed {answer.get('committed')!r}, not {committed}")
        return answer

    def digest(self, step):
        status, answer = self.wd.get("/digest")
        emit(self.records, {"measure": "product-digest", "step": step, **answer})
        return answer

    def evict(self, step):
        """Reset the object (`ctx.abort()`, or an idle long enough for local
        workerd to evict it), then show that the next request met a new
        object: no instance and a young age."""
        t0 = time.perf_counter()
        if self.args.evict == "abort":
            status, aborted = self.wd.get("/abort")
        else:
            status, aborted = 0, {}
            idle(self.args.idle or 15)
        evict_ms = round((time.perf_counter() - t0) * 1000, 1)
        t0 = time.perf_counter()
        status, memory = self.wd.get("/memory")
        first_request_ms = round((time.perf_counter() - t0) * 1000, 1)
        record = {
            "measure": "product-evict",
            "step": step,
            "how": self.args.evict,
            "evict_ms": evict_ms,
            "abort_answer": aborted.get("error") if isinstance(aborted, dict) else None,
            "object_first_request_ms": first_request_ms,
            "object_age_ms": memory.get("objectAgeMs"),
            "has_instance": memory.get("hasInstance"),
        }
        emit(self.records, record)
        self.expect(step, memory.get("hasInstance") is False, "the object kept its instance")
        return record

    def open(self, step, fresh, lazy=False):
        return self.answer(step, "/open", 0, "", committed=True, fresh=int(fresh), lazy=int(lazy),
                           profile=self.args.profile, limits=self.args.limits)

    def ready(self, step):
        return self.answer(step, "/ready", 0, READY_LINE, committed=True)

    def close(self, step):
        return self.answer(step, "/close", 0, "", committed=True)


def cmd_product(args, wd, records):
    """The product module end to end in a Durable Object; see README.md."""
    module = Path(args.module)
    data = module.read_bytes()
    emit(records, {
        "measure": "product-module",
        "path": str(module),
        "bytes": len(data),
        "gzip_bytes": len(gzip.compress(data, 9)),
        "workerd_start_ms": wd.start_ms,
        "host_abi": str(HOST_ABI),
    })
    p = Product(wd, records, args)
    status, probe = wd.get("/probe")
    emit(records, {"measure": "product-probe", **probe})

    # 1. A fresh open, the real boot bundles, ready.
    status, ensure = wd.get("/instance/ensure")
    emit(records, {"measure": "product-instantiate", "step": "fresh", **ensure})
    t0 = time.perf_counter()
    p.open("fresh-open", fresh=True)
    for path in args.boot:
        source = Path(path).read_text()
        p.answer(f"boot {Path(path).name}", "/boot", 0, "", committed=True, body=source, name=Path(path).name)
    p.ready("fresh-ready")
    emit(records, {"measure": "product-boot-total", "wall_ms": round((time.perf_counter() - t0) * 1000, 1),
                   "instantiate_ms": ensure.get("instantiateMs")})
    p.digest("after-boot")
    status, types = wd.get("/types")
    emit(records, {"measure": "product-key-types", **types})

    # 2. Requests, then close.
    replies = {
        "eval": reply_of("42"),
        "deliver": reply_of(json.dumps([PRODUCT_FRAME], separators=(",", ":"))),
    }
    for step, line in PRODUCT_REQUESTS:
        if step == "malformed":
            p.answer(step, "/request", 0, lambda m: isinstance(m, str) and m.startswith('{"message":') and '"op":"error"' in m,
                     committed=True, body=line)
        elif step == "close-request":
            p.answer(step, "/request", 1, "", committed=True, body=line)
        else:
            p.answer(step, "/request", 0, replies[step], committed=True, body=line)
    p.close("close")
    committed = p.digest("after-close")

    # 3. Wakes: evict, then a non-fresh open, eager and lazy.
    for n in range(args.wakes):
        for lazy in (False, True):
            label = f"wake-{'lazy' if lazy else 'eager'}-{n}"
            evicted = p.evict(f"{label} evict")
            status, ensure = wd.get("/instance/ensure")
            emit(records, {"measure": "product-instantiate", "step": label, **ensure})
            opened = p.open(f"{label} open", fresh=False, lazy=lazy)
            readied = p.ready(f"{label} ready")
            reply = p.answer(f"{label} request", "/request", 0, reply_of("41"), committed=True,
                             body=json.dumps({"source": "kept"}))
            closed = p.close(f"{label} close")
            emit(records, {
                "measure": "product-wake",
                "label": label,
                "lazy": lazy,
                "object_first_request_ms": evicted["object_first_request_ms"],
                "object_age_ms": evicted["object_age_ms"],
                "instantiate_ms": ensure.get("instantiateMs"),
                "open_ms": opened.get("ms"),
                "open_rows_read": opened.get("rowsRead"),
                "open_rows_written": opened.get("rowsWritten"),
                "open_bytes_returned": opened.get("bytesReturned"),
                "ready_ms": readied.get("ms"),
                "request_ms": reply.get("ms"),
                "request_rows_read": reply.get("rowsRead"),
                "wake_to_reply_ms": summed(ensure.get("instantiateMs"), opened.get("ms"), readied.get("ms"), reply.get("ms")),
                "close_ms": closed.get("ms"),
                "close_rows_written": closed.get("rowsWritten"),
                "close_bytes_bound": closed.get("bytesBound"),
                "sync_ms": closed.get("syncMs"),
                "memory_after_request": reply.get("memory"),
            })
    committed = p.digest("after-wakes")

    # 4. A rolled-back call leaves storage at the prior commit, and a new
    # instance resumes that commit.
    p.open("rollback open", fresh=False)
    p.ready("rollback ready")
    p.answer("rollback request", "/request", 0, reply_of("5"), committed=True, body=json.dumps({"source": "globalThis.y = 5"}))
    wd.get("/rollback-next")
    rolled = p.answer("rollback close", "/close", 0, "", committed=False)
    p.expect("rollback close", rolled.get("dropped") is True, "the instance was not dropped")
    after = p.digest("after-rollback")
    p.expect("rollback digest", after.get("digest") == committed.get("digest"), "storage changed under a rolled-back close")
    p.evict("rollback evict")
    p.open("rollback resume open", fresh=False)
    p.ready("rollback resume ready")
    p.answer("rollback resume typeof y", "/request", 0, reply_of("undefined"), committed=True,
             body=json.dumps({"source": "typeof y"}))
    p.answer("rollback resume kept", "/request", 0, reply_of("41"), committed=True, body=json.dumps({"source": "kept"}))
    p.close("rollback resume close")
    committed = p.digest("after-rollback-resume")

    # 5a. A fatal crank: status 3 with the fatal line, then refusals, and
    # nothing committed.
    p.open("fatal open", fresh=False)
    p.ready("fatal ready")
    p.answer("fatal set", "/request", 0, reply_of("2"), committed=True, body=json.dumps({"source": "kept = 2"}))
    p.answer("fatal crank", "/request", 3,
             lambda m: isinstance(m, str) and m.startswith('{"message":"guest crank halted') and m.endswith('"op":"fatal"}\n'),
             committed=False, body=json.dumps({"source": "for (;;) {}", "budget": "100000"}))
    p.answer("fatal refused", "/request", 4,
             lambda m: isinstance(m, str) and m.startswith("worker is dead after a failed crank: "),
             committed=False, body=json.dumps({"source": "kept"}))
    p.answer("fatal close", "/close", 1,
             lambda m: isinstance(m, str) and m.startswith("worker is dead after a failed crank: "), committed=False)
    after = p.digest("after-fatal")
    p.expect("fatal digest", after.get("digest") == committed.get("digest"), "storage changed after a fatal crank")
    p.open("fatal reopen", fresh=False)
    p.ready("fatal reopen ready")
    p.answer("fatal reopen kept", "/request", 0, reply_of("41"), committed=True, body=json.dumps({"source": "kept"}))
    p.close("fatal reopen close")
    committed = p.digest("after-fatal-reopen")

    # 5b. A host statement failure during the close: status 1 with the
    # executor's text, nothing committed, and a new instance resumes the
    # prior commit. The fault is armed on the third statement of the close,
    # past the manifest read, among the writes.
    p.open("fault open", fresh=False)
    p.ready("fault ready")
    p.answer("fault set", "/request", 0, reply_of("1"), committed=True, body=json.dumps({"source": "globalThis.z = 1"}))
    wd.get("/fault", at=args.fault_at)
    failed = p.answer("fault close", "/close", 1, f'checkpoint: Io("injected failure at statement {args.fault_at}")',
                      committed=False)
    after = p.digest("after-fault")
    p.expect("fault digest", after.get("digest") == committed.get("digest"), "storage changed after a failed statement")
    p.expect("fault close", failed.get("trap") is None, "the failed statement surfaced as an exception")
    p.evict("fault evict")
    p.open("fault resume open", fresh=False)
    p.ready("fault resume ready")
    p.answer("fault resume typeof z", "/request", 0, reply_of("undefined"), committed=True,
             body=json.dumps({"source": "typeof z"}))
    p.close("fault resume close")

    log = wd.log_text()
    emit(records, {
        "measure": "product-summary",
        "failures": p.failures,
        "workerd_log_lines": len(log.splitlines()),
        "workerd_log_tail": log.splitlines()[-20:],
    })
    return len(p.failures)


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
        p.add_argument("--slots", type=int, default=SLOT_CEILING, help="slot ceiling")
        p.add_argument("--chunk", type=int, default=CHUNK_CEILING, help="chunk ceiling in bytes")
        p.add_argument("--crank", default="1 + 1", help="the source of the wake's request")
        p.add_argument("--budget", type=int, default=CRANK_BUDGET, help="the crank budget, in computrons")
        if name == "boot":
            p.add_argument("--boot", action="append", required=True, help="a boot file (repeatable)")
        if name == "wake":
            p.add_argument("--container", required=True)
        if name == "sweep":
            p.add_argument("--only", action="append")
    p = sub.add_parser("export")
    p.add_argument("--store", type=int, default=1)
    p.add_argument("--out", required=True)
    p = sub.add_parser("product")
    p.add_argument("--module", default=str(PRODUCT_MODULE), help="the product module (rust/thixotrope-ironhorse-wasm/build.py)")
    p.add_argument("--boot", action="append", help="a boot file (repeatable); default the two Thixotrope bundles")
    p.add_argument("--profile", default="thixotrope-wasm-do")
    p.add_argument("--wakes", type=int, default=1, help="wakes per mode, eager and lazy")
    p.add_argument("--evict", choices=("abort", "idle"), default="abort", help="how the object is reset before a wake")
    p.add_argument("--idle", type=float, default=15, help="seconds to idle with --evict idle")
    p.add_argument("--fault-at", type=int, default=3, help="the statement of the close that fails")
    args = parser.parse_args()
    if args.command == "build":
        print(build())
        return
    if args.command == "product":
        args.boot = args.boot or [str(BOOT_DIR / "boot.js"), str(BOOT_DIR / "worker-peer.js")]
        args.limits = json.dumps({
            "crankBudget": str(CRANK_BUDGET),
            "bootstrapBudget": str(BOOT_BUDGET),
            "slotCeiling": SLOT_CEILING,
            "chunkCeiling": CHUNK_CEILING,
            "requestTimeoutMs": 60_000,
        })
        if not Path(args.module).exists():
            raise SystemExit(f"no product module at {args.module}; run python3 rust/thixotrope-ironhorse-wasm/build.py")
        module = None
    else:
        module = MODULE if args.no_build else build(quiet=True)
    if args.command == "suite":
        args.parts = [p for p in args.parts.split(",") if p]
    flags = [f for f in args.v8_flags.split(",") if f]
    records = []
    global JSON_OUT
    if args.json:
        JSON_OUT = open(args.json, "w")
    product = args.module if args.command == "product" else None
    wd = Workerd(workerd_binary(), module, flags, keep=args.keep, product=product)
    try:
        commands = {
            "suite": cmd_suite,
            "boot": cmd_boot,
            "wake": cmd_wake,
            "sweep": cmd_sweep,
            "export": cmd_export,
            "product": cmd_product,
        }
        failures = commands[args.command](args, wd, records)
    finally:
        wd.close()
        if JSON_OUT is not None:
            JSON_OUT.close()
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
