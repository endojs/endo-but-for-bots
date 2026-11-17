// The spike's Durable Object host: the engine module bundled with the Worker,
// instantiated lazily inside each handler, a `sql.exec` shim that returns
// error codes instead of throwing through wasm, every crank inside one
// `transactionSync`, and the instance dropped after any exception (the
// verification review's work item 4). Routes answer JSON with the export's
// status, its message, wall-clock time, SQL row counters and linear memory.
import { DurableObject } from "cloudflare:workers";
import engine from "spike.wasm";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

// The host side of the ABI in src/host.rs: tagged values both ways.
class Host {
  constructor(sql) {
    this.sql = sql;
    this.memory = null;
    this.pending = null;
    this.rowsRead = 0;
    this.rowsWritten = 0;
    this.execs = 0;
    this.log = [];
  }
  bytes() {
    return new Uint8Array(this.memory.buffer);
  }
  view() {
    return new DataView(this.memory.buffer);
  }
  decodeParams(ptr, len) {
    const view = this.view();
    const bytes = this.bytes();
    const params = [];
    let at = ptr;
    const end = ptr + len;
    while (at < end) {
      const tag = bytes[at++];
      if (tag === 0) params.push(null);
      else if (tag === 1) {
        params.push(view.getFloat64(at, true));
        at += 8;
      } else if (tag === 2 || tag === 3) {
        const n = view.getUint32(at, true);
        at += 4;
        const slice = bytes.slice(at, at + n);
        at += n;
        params.push(tag === 2 ? slice.buffer : decoder.decode(slice));
      } else throw new Error(`bad parameter tag ${tag}`);
    }
    return params;
  }
  encodeRows(rows) {
    let buffer = new Uint8Array(4096);
    let view = new DataView(buffer.buffer);
    let at = 0;
    const need = (n) => {
      if (at + n <= buffer.length) return;
      let size = buffer.length * 2;
      while (size < at + n) size *= 2;
      const grown = new Uint8Array(size);
      grown.set(buffer.subarray(0, at));
      buffer = grown;
      view = new DataView(buffer.buffer);
    };
    const u32 = (n) => {
      need(4);
      view.setUint32(at, n, true);
      at += 4;
    };
    u32(rows.length);
    for (const row of rows) {
      u32(row.length);
      for (const value of row) {
        if (value === null || value === undefined) {
          need(1);
          buffer[at++] = 0;
        } else if (typeof value === "number") {
          need(9);
          buffer[at++] = 1;
          view.setFloat64(at, value, true);
          at += 8;
        } else if (typeof value === "bigint") {
          need(9);
          buffer[at++] = 1;
          view.setFloat64(at, Number(value), true);
          at += 8;
        } else if (value instanceof ArrayBuffer) {
          const bytes = new Uint8Array(value);
          need(5 + bytes.length);
          buffer[at++] = 2;
          view.setUint32(at, bytes.length, true);
          at += 4;
          buffer.set(bytes, at);
          at += bytes.length;
        } else if (typeof value === "string") {
          const bytes = encoder.encode(value);
          need(5 + bytes.length);
          buffer[at++] = 3;
          view.setUint32(at, bytes.length, true);
          at += 4;
          buffer.set(bytes, at);
          at += bytes.length;
        } else throw new Error(`unencodable column ${typeof value}`);
      }
    }
    return buffer.subarray(0, at);
  }
  get imports() {
    return {
      host_exec: (sqlPtr, sqlLen, paramsPtr, paramsLen) => {
        try {
          const sql = decoder.decode(this.bytes().subarray(sqlPtr, sqlPtr + sqlLen));
          const params = this.decodeParams(paramsPtr, paramsLen);
          const cursor = this.sql.exec(sql, ...params);
          const rows = Array.from(cursor.raw());
          this.execs += 1;
          this.rowsRead += cursor.rowsRead;
          this.rowsWritten += cursor.rowsWritten;
          this.pending = this.encodeRows(rows);
          return this.pending.length;
        } catch (error) {
          this.pending = encoder.encode(String(error && error.message ? error.message : error));
          return -1;
        }
      },
      host_take: (dst, cap) => {
        const pending = this.pending || new Uint8Array(0);
        const n = Math.min(pending.length, cap);
        this.bytes().set(pending.subarray(0, n), dst);
        this.pending = null;
        return n;
      },
      host_log: (ptr, len) => {
        this.log.push(decoder.decode(this.bytes().subarray(ptr, ptr + len)));
      },
      host_random: (ptr, len) => {
        crypto.getRandomValues(this.bytes().subarray(ptr, ptr + len));
      },
    };
  }
}

// The standard library's WASI preview1 imports (the module is built for
// wasm32-wasip1 so that the acceptance suite's own sessions, which draw from
// the engine's default commit-token source, can run: that source needs a
// clock and seeded hash keys, which WASI has and wasm32-unknown-unknown does
// not). Only what std reaches for: randomness, the clock, stderr for panic
// messages, exit, and empty arguments and environment. Anything else answers
// ENOSYS through the proxy below, so an unexpected import is a loud error,
// not a silent success.
class ProcExit {
  constructor(code) {
    this.code = code;
  }
}

class RolledBack {}

// A caller's malformed request: answered 400 without touching the instance.
class BadRequest extends Error {}

function wasi(host) {
  const ENOSYS = 52;
  const known = {
    args_sizes_get(countPtr, sizePtr) {
      host.view().setUint32(countPtr, 0, true);
      host.view().setUint32(sizePtr, 0, true);
      return 0;
    },
    args_get() {
      return 0;
    },
    environ_sizes_get(countPtr, sizePtr) {
      host.view().setUint32(countPtr, 0, true);
      host.view().setUint32(sizePtr, 0, true);
      return 0;
    },
    environ_get() {
      return 0;
    },
    random_get(ptr, len) {
      crypto.getRandomValues(host.bytes().subarray(ptr, ptr + len));
      return 0;
    },
    clock_time_get(id, precision, outPtr) {
      host.view().setBigUint64(outPtr, BigInt(Math.round(Date.now() * 1e6)), true);
      return 0;
    },
    fd_write(fd, iovs, iovsLen, nwrittenPtr) {
      let written = 0;
      let text = "";
      for (let i = 0; i < iovsLen; i++) {
        const ptr = host.view().getUint32(iovs + 8 * i, true);
        const len = host.view().getUint32(iovs + 8 * i + 4, true);
        text += decoder.decode(host.bytes().subarray(ptr, ptr + len));
        written += len;
      }
      if (text) host.log.push(`fd${fd}: ${text}`);
      host.view().setUint32(nwrittenPtr, written, true);
      return 0;
    },
    fd_read(fd, iovs, iovsLen, nreadPtr) {
      host.view().setUint32(nreadPtr, 0, true);
      return 0;
    },
    fd_close() {
      return 0;
    },
    fd_fdstat_get() {
      return ENOSYS;
    },
    fd_seek() {
      return ENOSYS;
    },
    proc_exit(code) {
      throw new ProcExit(code);
    },
  };
  return new Proxy(known, {
    get(target, name) {
      if (name in target) return target[name];
      return () => {
        host.log.push(`wasi: ${String(name)} is not provided`);
        return ENOSYS;
      };
    },
  });
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class Spike extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.instance = null;
    this.host = null;
    this.instantiateMs = null;
    this.constructedAt = now();
  }

  async ensureInstance() {
    if (this.instance) return;
    const t0 = now();
    const host = new Host(this.sql);
    const instance = await WebAssembly.instantiate(engine, {
      env: host.imports,
      wasi_snapshot_preview1: wasi(host),
    });
    host.memory = instance.exports.memory;
    // The module links no crt object and exports no `_initialize` (a wasip1
    // cdylib is not made a WASI reactor by rustc; it has no constructors to
    // run and no start section). Should a build ever export one, it runs
    // once here, before any other export.
    if (typeof instance.exports._initialize === "function") instance.exports._initialize();
    this.host = host;
    this.instance = instance;
    this.instantiateMs = now() - t0;
  }

  dropInstance() {
    const had = this.instance !== null;
    this.instance = null;
    this.host = null;
    return had;
  }

  // Guest memory from `ih_alloc`; null means linear memory could not grow,
  // and the throw drops the instance rather than write at address zero.
  alloc(len) {
    const ptr = this.instance.exports.ih_alloc(len);
    if (ptr === 0 && len > 0) throw new Error(`ih_alloc(${len}) refused: linear memory cannot grow`);
    return ptr;
  }

  takeMessage() {
    const exports = this.instance.exports;
    const len = exports.ih_message_len();
    const ptr = this.alloc(len);
    const n = exports.ih_message_copy(ptr, len);
    const bytes = this.host.bytes().slice(ptr, ptr + n);
    exports.ih_free(ptr, len);
    return bytes;
  }

  put(bytes) {
    const ptr = this.alloc(bytes.length);
    this.host.bytes().set(bytes, ptr);
    return ptr;
  }

  // Run an export that commits inside one transaction: a failed status
  // throws so SQL rolls back the partial batch, and the instance is dropped,
  // as after a trap. The result is returned either way, with the durable
  // write's time: `transactionSync` only stages the rows, and workerd
  // writes them to storage after the handler yields (the output gate), so
  // the export's own `ms` excludes it and `syncMs` measures it.
  async committed(tx, f) {
    let result = null;
    try {
      tx(() => {
        result = f();
        if (result.status !== 0) throw new RolledBack();
      });
    } catch (error) {
      if (!(error instanceof RolledBack)) throw error;
      this.dropInstance();
      return result;
    }
    result.syncMs = await this.sync();
    return result;
  }

  // Wait for the staged writes to reach storage, and say how long that took.
  async sync() {
    const t0 = now();
    await this.ctx.storage.sync();
    return now() - t0;
  }

  // Call one export; a trap or a JS exception escaping it drops the instance.
  call(name, ...args) {
    const host = this.host;
    const before = { rowsRead: host.rowsRead, rowsWritten: host.rowsWritten, execs: host.execs };
    const t0 = now();
    let status;
    try {
      status = this.instance.exports[name](...args);
    } catch (error) {
      const trap =
        error instanceof ProcExit ? `proc_exit(${error.code})` : error && error.message ? error.message : String(error);
      const log = host.log.splice(0);
      this.dropInstance();
      const failure = new Error(`trap in ${name}: ${trap}`);
      failure.detail = { trap: true, name, message: trap, log };
      throw failure;
    }
    const ms = now() - t0;
    const message = this.takeMessage();
    const result = {
      status,
      message,
      ms,
      rowsRead: host.rowsRead - before.rowsRead,
      rowsWritten: host.rowsWritten - before.rowsWritten,
      execs: host.execs - before.execs,
      memory: host.memory.buffer.byteLength,
      log: host.log.splice(0),
    };
    // A caught unwind (status 2) leaves the machine mid-crank; the engine
    // says such a machine must be rewound, and the spike's rewind is a fresh
    // instance, so the instance goes once its message is copied out.
    if (status === 2) this.dropInstance();
    return result;
  }

  text(result) {
    return { ...result, message: decoder.decode(result.message) };
  }

  // Call an export with `text` copied into guest memory; `args(ptr, len)`
  // places the pointer and length among the other arguments.
  withText(name, text, args = (ptr, len) => [ptr, len]) {
    const bytes = encoder.encode(text);
    const ptr = this.put(bytes);
    try {
      return this.call(name, ...args(ptr, bytes.length));
    } finally {
      if (this.instance) this.instance.exports.ih_free(ptr, bytes.length);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const q = (name, fallback) => url.searchParams.get(name) ?? fallback;
    // Every other numeric parameter is a wasm u32 (a store id, a ceiling, a
    // flag): a decimal integer within u32, or the caller's error.
    const u32 = (name, fallback) => {
      const text = q(name, String(fallback));
      if (!/^\d{1,10}$/.test(text) || Number(text) > 0xffffffff) {
        throw new BadRequest(`${name} must be a decimal integer within u32, not ${JSON.stringify(text)}`);
      }
      return Number(text);
    };
    // A computron budget is the worker's u64: a wasm i64, a JS BigInt. Only
    // a decimal integer within u64 is accepted; a malformed one is the
    // caller's error, not a reason to drop a healthy instance.
    const budget = () => {
      const text = q("budget", "10000000");
      if (!/^\d{1,20}$/.test(text)) throw new BadRequest(`budget must be a decimal integer, not ${JSON.stringify(text)}`);
      const value = BigInt(text);
      if (value > 0xffffffffffffffffn) throw new BadRequest(`budget ${text} exceeds u64`);
      return value;
    };
    const tx = (f) => (q("tx", "1") === "0" ? f() : this.ctx.storage.transactionSync(f));
    try {
      switch (url.pathname) {
        case "/memory":
          return json({
            hasInstance: this.instance !== null,
            memory: this.instance ? this.host.memory.buffer.byteLength : null,
            instantiateMs: this.instantiateMs,
            objectAgeMs: now() - this.constructedAt,
          });
        case "/instance/drop":
          return json({ dropped: this.dropInstance() });
        case "/instance/ensure": {
          await this.ensureInstance();
          return json({ instantiateMs: this.instantiateMs, memory: this.host.memory.buffer.byteLength });
        }
        case "/suite": {
          await this.ensureInstance();
          const part = q("name", "sparse");
          const result = await this.committed(tx, () => this.text(this.withText("ih_run_suite", part)));
          return json({ part, ...result });
        }
        case "/store/open": {
          await this.ensureInstance();
          return json(await this.committed(tx, () => this.text(this.call("ih_store_open", u32("store", 1), u32("reset", 0)))));
        }
        case "/import": {
          // The body is read before the instance is taken: the input gate is
          // open while a body streams in, so another request could drop it.
          const bytes = new Uint8Array(await request.arrayBuffer());
          await this.ensureInstance();
          const profile = encoder.encode(q("profile", "spike"));
          const ptr = this.put(bytes);
          const profilePtr = this.put(profile);
          const result = await this.committed(tx, () =>
            this.text(this.call("ih_import", u32("store", 1), ptr, bytes.length, profilePtr, profile.length)),
          );
          if (this.instance) {
            this.instance.exports.ih_free(ptr, bytes.length);
            this.instance.exports.ih_free(profilePtr, profile.length);
          }
          return json({ containerBytes: bytes.length, ...result });
        }
        case "/export": {
          await this.ensureInstance();
          const result = this.call("ih_export", u32("store", 1));
          if (result.status !== 0) return json(this.text(result), 500);
          return new Response(result.message, {
            headers: { "content-type": "application/octet-stream", "x-ms": String(result.ms) },
          });
        }
        case "/session/begin": {
          await this.ensureInstance();
          return json(
            await this.committed(tx, () =>
              this.text(
                this.withText("ih_session_begin", q("profile", "spike"), (ptr, len) => [
                  u32("store", 1),
                  ptr,
                  len,
                  u32("slots", 0),
                  u32("chunk", 0),
                ]),
              ),
            ),
          );
        }
        case "/session/resume": {
          await this.ensureInstance();
          const t0 = now();
          const result = this.text(
            this.withText("ih_session_resume", q("profile", "spike"), (ptr, len) => [
              u32("store", 1),
              u32("lazy", 1),
              ptr,
              len,
              u32("slots", 0),
              u32("chunk", 0),
            ]),
          );
          return json({ ...result, totalMs: now() - t0, instantiateMs: this.instantiateMs });
        }
        case "/session/eval": {
          const source = await request.text();
          await this.ensureInstance();
          return json(this.text(this.withText("ih_session_eval", source, (ptr, len) => [ptr, len, budget()])));
        }
        case "/session/checkpoint": {
          await this.ensureInstance();
          return json(await this.committed(tx, () => this.text(this.call("ih_session_checkpoint"))));
        }
        case "/session/stats": {
          await this.ensureInstance();
          const result = this.text(this.call("ih_session_stats"));
          return json({ ...result, stats: result.status === 0 ? JSON.parse(result.message) : null });
        }
        case "/session/drop": {
          await this.ensureInstance();
          return json(this.text(this.call("ih_session_drop")));
        }
        case "/crank": {
          // The production shape: one crank, its checkpoint, one transaction.
          // A halt or a store failure throws inside the callback so SQL rolls
          // back; the instance is then dropped, as the contract requires.
          // `totalMs` spans the transaction and the durable write (`syncMs`).
          const source = await request.text();
          const crankBudget = budget();
          await this.ensureInstance();
          const t0 = now();
          let evalResult = null;
          let checkpointResult = null;
          try {
            tx(() => {
              evalResult = this.text(this.withText("ih_session_eval", source, (ptr, len) => [ptr, len, crankBudget]));
              if (evalResult.status !== 0) throw new Error(`eval: ${evalResult.message}`);
              checkpointResult = this.text(this.call("ih_session_checkpoint"));
              if (checkpointResult.status !== 0) throw new Error(`checkpoint: ${checkpointResult.message}`);
            });
          } catch (error) {
            this.dropInstance();
            return json(
              {
                ok: false,
                error: error.message,
                detail: error.detail ?? null,
                eval: evalResult,
                checkpoint: checkpointResult,
                totalMs: now() - t0,
              },
              500,
            );
          }
          const syncMs = await this.sync();
          return json({ ok: true, eval: evalResult, checkpoint: checkpointResult, syncMs, totalMs: now() - t0 });
        }
        default:
          return json({ error: `no route ${url.pathname}` }, 404);
      }
    } catch (error) {
      if (error instanceof BadRequest) return json({ error: error.message }, 400);
      this.dropInstance();
      return json({ error: error.message, detail: error.detail ?? null }, 500);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const name = url.searchParams.get("do") ?? "main";
    const stub = env.SPIKE.get(env.SPIKE.idFromName(name));
    return stub.fetch(request);
  },
};
