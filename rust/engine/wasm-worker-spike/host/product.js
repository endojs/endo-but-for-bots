// The product module in a Durable Object: `thixotrope_ironhorse_wasm.wasm`
// as `rust/thixotrope-ironhorse-wasm/build.py` leaves it, driven through the
// real `host-abi.mjs` (bundled from its own path, never copied), with
// `ctx.storage.sql` as the statement executor and one
// `ctx.storage.transactionSync` per status-answering export call, committed
// only when the status says so (the crate documentation's "The host's
// transaction"). Routes answer JSON with the export's status and message,
// wall-clock time, the SQL cursor's row counters, the bytes bound and
// returned, whether the call committed, and linear memory.
import { DurableObject } from "cloudflare:workers";
import { STATUS, makeExports, makeHostImports, makeWasiImports } from "host-abi.mjs";
import productModule from "product.wasm";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const encoder = new TextEncoder();

// The signal that rolls a call's transaction back: thrown inside the
// `transactionSync` callback, which is the only way a Durable Object rolls
// one back, and recognised outside it so the answer still reaches the caller.
class RolledBack {}

// A caller's malformed request: answered 400 without touching the instance.
class BadRequest extends Error {}

// The product host's default limits (makeIronhorseLimits).
const DEFAULT_LIMITS = JSON.stringify({
  crankBudget: "10000000",
  bootstrapBudget: "1000000000",
  slotCeiling: 1000000,
  chunkCeiling: 268435456,
  requestTimeoutMs: 60000,
});

// The statuses each export commits on: `ih_request`'s close (1) commits like
// a reply, since nothing ran; every other non-zero status rolls back.
const COMMITS = {
  open: [STATUS.OK],
  boot: [STATUS.OK],
  ready: [STATUS.OK],
  request: [STATUS.OK, STATUS.CLOSE],
  close: [STATUS.OK],
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

// The store's tables, in a fixed order, with their keys: what a digest of
// the stored heap reads.
const TABLES = [
  ["ih_meta", "store, key"],
  ["ih_slot_pages", "store, page"],
  ["ih_chunk_exts", "store, ext"],
  ["ih_free_segs", "store, seg"],
  ["ih_page_edges", "store, page"],
  ["ih_sections", "store, id, chunk"],
];

export class Product extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.instance = null;
    this.exports = null;
    this.memory = null;
    this.log = [];
    this.counters = { execs: 0, rowsRead: 0, rowsWritten: 0, bytesBound: 0, bytesReturned: 0 };
    // `{ at }`: fail the statement that many executions from when it was set.
    this.fault = null;
    this.rollbackNext = false;
    this.instantiateMs = null;
    this.constructedAt = now();
  }

  // The executor `host-abi.mjs` calls: one statement, its rows as arrays.
  exec(sql, params) {
    this.counters.execs += 1;
    if (this.fault) {
      this.fault.seen += 1;
      if (this.fault.seen === this.fault.at) {
        const at = this.fault.at;
        this.fault = null;
        throw new Error(`injected failure at statement ${at}`);
      }
    }
    for (const param of params) {
      if (typeof param === "string") this.counters.bytesBound += encoder.encode(param).length;
      else if (param instanceof ArrayBuffer || ArrayBuffer.isView(param)) this.counters.bytesBound += param.byteLength;
    }
    const cursor = this.sql.exec(sql, ...params);
    const rows = Array.from(cursor.raw());
    this.counters.rowsRead += cursor.rowsRead;
    this.counters.rowsWritten += cursor.rowsWritten;
    for (const row of rows) {
      for (const value of row) {
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) this.counters.bytesReturned += value.byteLength;
        else if (typeof value === "string") this.counters.bytesReturned += value.length;
      }
    }
    return rows;
  }

  async ensureInstance() {
    if (this.instance) return;
    const t0 = now();
    const getMemory = () => {
      if (this.memory === null) throw new Error("the instance has no memory yet");
      return this.memory;
    };
    const random = (bytes) => crypto.getRandomValues(bytes);
    const log = (line) => this.log.push(line);
    // host-abi's default `bindBlob` (a Uint8Array copy): `sql.exec` binds
    // any ArrayBufferView as a blob (the probe below shows it).
    const instance = await WebAssembly.instantiate(productModule, {
      env: makeHostImports({ getMemory, exec: (sql, params) => this.exec(sql, params), random, log }),
      wasi_snapshot_preview1: makeWasiImports({
        getMemory,
        random,
        nowNs: () => BigInt(Math.round(Date.now() * 1e6)),
        log,
      }),
    });
    this.memory = instance.exports.memory;
    this.exports = makeExports(instance);
    this.instance = instance;
    this.instantiateMs = now() - t0;
  }

  dropInstance() {
    const had = this.instance !== null;
    this.instance = null;
    this.exports = null;
    this.memory = null;
    return had;
  }

  // One status-answering export call inside one `transactionSync`. Answers
  // the status and message whether the transaction committed or not; a
  // trap or a JS exception escaping the export (which also rolls the
  // transaction back) drops the instance, and so does a rolled-back call
  // whose status said commit (the machine has advanced past the database)
  // and a caught unwind (the instance is poisoned).
  async call(kind, f) {
    const before = { ...this.counters };
    const forced = this.rollbackNext;
    this.rollbackNext = false;
    const t0 = now();
    let answer = null;
    let committed = false;
    let trap = null;
    try {
      this.ctx.storage.transactionSync(() => {
        answer = f(this.exports);
        if (forced || !COMMITS[kind].includes(answer.status)) throw new RolledBack();
      });
      committed = true;
    } catch (error) {
      if (!(error instanceof RolledBack)) {
        trap = error && error.message ? `${error.name}: ${error.message}` : String(error);
      }
    }
    const ms = now() - t0;
    const memory = this.memory ? this.memory.buffer.byteLength : null;
    let dropped = false;
    if (trap !== null || answer.status === STATUS.UNWIND || (!committed && COMMITS[kind].includes(answer.status))) {
      dropped = this.dropInstance();
    }
    const syncMs = committed ? await this.sync() : null;
    const delta = (name) => this.counters[name] - before[name];
    return {
      kind,
      status: answer ? answer.status : null,
      message: answer ? answer.message : null,
      trap,
      committed,
      forcedRollback: forced,
      dropped,
      ms,
      syncMs,
      execs: delta("execs"),
      rowsRead: delta("rowsRead"),
      rowsWritten: delta("rowsWritten"),
      bytesBound: delta("bytesBound"),
      bytesReturned: delta("bytesReturned"),
      memory,
      log: this.log.splice(0),
    };
  }

  async sync() {
    const t0 = now();
    await this.ctx.storage.sync();
    return now() - t0;
  }

  // A SHA-256 over every row of the store's tables, in key order, with the
  // row counts: equal digests are equal stored heaps.
  async digest() {
    const existing = new Set(
      Array.from(this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").raw()).map((row) => row[0]),
    );
    const parts = [];
    const counts = {};
    for (const [table, key] of TABLES) {
      if (!existing.has(table)) continue;
      const rows = Array.from(this.sql.exec(`SELECT * FROM ${table} ORDER BY ${key}`).raw());
      counts[table] = rows.length;
      for (const row of rows) {
        for (const value of row) {
          if (value instanceof ArrayBuffer) {
            parts.push(encoder.encode(`b${value.byteLength}:`), new Uint8Array(value));
          } else {
            parts.push(encoder.encode(`${typeof value}:${String(value)};`));
          }
        }
      }
    }
    const total = parts.reduce((n, part) => n + part.length, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.length;
    }
    let manifest = null;
    if (existing.has("ih_meta")) {
      const rows = Array.from(
        this.sql.exec("SELECT value FROM ih_meta WHERE store = 1 AND key = 'manifest'").raw(),
      );
      if (rows.length) manifest = hex(await crypto.subtle.digest("SHA-256", rows[0][0]));
    }
    return { digest: hex(await crypto.subtle.digest("SHA-256", all)), bytes: total, counts, manifest };
  }

  // The storage class SQLite gave each integer key the store wrote: the
  // module binds every integer as a double, which `sql.exec` binds as a
  // REAL, and the tables' INTEGER affinity is what turns it back.
  types() {
    const results = {};
    for (const [table, key] of TABLES) {
      const columns = key.split(", ").filter((column) => column !== "key");
      const select = columns.map((column) => `typeof(${column})`).join(" || ',' || ");
      results[table] = Array.from(this.sql.exec(`SELECT DISTINCT ${select} FROM ${table}`).raw()).map((row) => row[0]);
    }
    return results;
  }

  // What `sql.exec` itself does with the values host-abi hands it and the
  // columns it answers, outside any export.
  probe() {
    const results = {};
    const attempt = (name, f) => {
      try {
        results[name] = f();
      } catch (error) {
        results[name] = { error: `${error.name}: ${error.message}` };
      }
    };
    const one = (sql, ...params) => {
      const rows = Array.from(this.sql.exec(sql, ...params).raw());
      return rows[0].map((value) =>
        value instanceof ArrayBuffer
          ? { type: "ArrayBuffer", byteLength: value.byteLength }
          : { type: typeof value, value: typeof value === "bigint" ? `${value}n` : value },
      );
    };
    attempt("bind Uint8Array", () => one("SELECT typeof(?1), length(?1)", new Uint8Array([1, 2, 3])));
    attempt("bind Uint8Array subarray", () =>
      one("SELECT typeof(?1), length(?1), hex(?1)", new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4)),
    );
    attempt("bind ArrayBuffer", () => one("SELECT typeof(?1), length(?1)", new Uint8Array([1, 2, 3]).buffer));
    attempt("bind DataView", () => one("SELECT typeof(?1), length(?1)", new DataView(new ArrayBuffer(3))));
    attempt("bind 7 (number)", () => one("SELECT typeof(?1), ?1", 7));
    attempt("bind 7.5 (number)", () => one("SELECT typeof(?1), ?1", 7.5));
    attempt("bind 2**53 (number)", () => one("SELECT typeof(?1), ?1", 2 ** 53));
    attempt("bind bigint", () => one("SELECT typeof(?1), ?1", 7n));
    attempt("integer columns", () => one("SELECT 1, 4294967295, 9007199254740993, 2.0, 2.5"));
    attempt("blob column", () => one("SELECT x'010203'"));
    attempt("empty blob column", () => one("SELECT x''"));
    return results;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const q = (name, fallback) => url.searchParams.get(name) ?? fallback;
    const flag = (name) => {
      const text = q(name, "0");
      if (text !== "0" && text !== "1") throw new BadRequest(`${name} must be 0 or 1`);
      return text === "1";
    };
    try {
      switch (url.pathname) {
        case "/memory":
          return json({
            hasInstance: this.instance !== null,
            memory: this.memory ? this.memory.buffer.byteLength : null,
            instantiateMs: this.instantiateMs,
            objectAgeMs: now() - this.constructedAt,
          });
        case "/instance/drop":
          return json({ dropped: this.dropInstance() });
        case "/instance/ensure": {
          const had = this.instance !== null;
          await this.ensureInstance();
          return json({
            reused: had,
            instantiateMs: this.instantiateMs,
            memory: this.memory.buffer.byteLength,
            objectAgeMs: now() - this.constructedAt,
          });
        }
        case "/open": {
          const options = {
            fresh: flag("fresh"),
            lazy: flag("lazy"),
            profile: q("profile", "thixotrope-wasm-do"),
            limits: q("limits", DEFAULT_LIMITS),
          };
          await this.ensureInstance();
          return json(await this.call("open", (exports) => exports.open(options)));
        }
        case "/boot": {
          const source = await request.text();
          await this.ensureInstance();
          const name = q("name", "boot");
          return json({ name, sourceBytes: source.length, ...(await this.call("boot", (exports) => exports.boot(name, source))) });
        }
        case "/ready":
          await this.ensureInstance();
          return json(await this.call("ready", (exports) => exports.ready()));
        case "/request": {
          const line = await request.text();
          await this.ensureInstance();
          return json({ line, ...(await this.call("request", (exports) => exports.request(line))) });
        }
        case "/close":
          await this.ensureInstance();
          return json(await this.call("close", (exports) => exports.close()));
        case "/fault": {
          const at = Number(q("at", "0"));
          this.fault = at > 0 ? { at, seen: 0 } : null;
          return json({ armed: this.fault });
        }
        case "/rollback-next":
          this.rollbackNext = true;
          return json({ rollbackNext: true });
        case "/digest":
          return json(await this.digest());
        case "/types":
          return json(this.types());
        case "/probe":
          return json(this.probe());
        case "/abort":
          // Resets the object: this request fails, and the next one
          // constructs it afresh, with no instance and the database reopened.
          this.ctx.abort("evicted by the harness");
          return json({ aborted: false });
        default:
          return json({ error: `no route ${url.pathname}` }, 404);
      }
    } catch (error) {
      if (error instanceof BadRequest) return json({ error: error.message }, 400);
      this.dropInstance();
      return json({ error: `${error.name}: ${error.message}`, log: this.log.splice(0) }, 500);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const name = url.searchParams.get("do") ?? "main";
    const stub = env.PRODUCT.get(env.PRODUCT.idFromName(name));
    try {
      return await stub.fetch(request);
    } catch (error) {
      return json({ error: `${error.name}: ${error.message}`, stub: true }, 500);
    }
  },
};
