// The stack-lanes probe as a Worker: one fresh instance per request, a WASI
// preview1 shim for the eight imports the probe uses, and the shadow-stack
// painter node/run.cjs uses (../shadow-paint.mjs, embedded beside this file).
// GET /?case=<name>[&paint=1] answers JSON:
// { stdout, stderr, exit, trap, shadowStack }. A trap is V8's RangeError (the
// host stack) or WebAssembly.RuntimeError (unreachable, out of bounds); any
// other failure is a 500 so the runner never mistakes it for a verdict.
import probe from "probe.wasm";
import { highWater, paint } from "shadow-paint.mjs";

class ProcExit {
  constructor(code) {
    this.code = code;
  }
}

function wasi(args, io) {
  let memory = null;
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);
  const encoder = new TextEncoder();
  const encoded = args.map((a) => encoder.encode(a + "\0"));
  // One streaming decoder per stream: the probe's line writer may split a
  // multi-byte sequence across two fd_write calls.
  const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
  return {
    setMemory(m) {
      memory = m;
    },
    flush() {
      io.stdout += decoders[1].decode();
      io.stderr += decoders[2].decode();
    },
    imports: {
      args_sizes_get(countPtr, sizePtr) {
        view().setUint32(countPtr, encoded.length, true);
        view().setUint32(sizePtr, encoded.reduce((n, a) => n + a.length, 0), true);
        return 0;
      },
      args_get(argvPtr, bufPtr) {
        let offset = bufPtr;
        encoded.forEach((a, i) => {
          view().setUint32(argvPtr + 4 * i, offset, true);
          bytes().set(a, offset);
          offset += a.length;
        });
        return 0;
      },
      environ_sizes_get(countPtr, sizePtr) {
        view().setUint32(countPtr, 0, true);
        view().setUint32(sizePtr, 0, true);
        return 0;
      },
      environ_get() {
        return 0;
      },
      random_get(ptr, len) {
        crypto.getRandomValues(bytes().subarray(ptr, ptr + len));
        return 0;
      },
      fd_read(fd, iovs, iovsLen, nreadPtr) {
        view().setUint32(nreadPtr, 0, true); // standard input is empty
        return 0;
      },
      fd_write(fd, iovs, iovsLen, nwrittenPtr) {
        let written = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = view().getUint32(iovs + 8 * i, true);
          const len = view().getUint32(iovs + 8 * i + 4, true);
          const text = decoders[fd === 1 ? 1 : 2].decode(bytes().subarray(ptr, ptr + len), { stream: true });
          if (fd === 1) io.stdout += text;
          else io.stderr += text;
          written += len;
        }
        view().setUint32(nwrittenPtr, written, true);
        return 0;
      },
      proc_exit(code) {
        throw new ProcExit(code);
      },
    },
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const name = url.searchParams.get("case");
    if (!name) return new Response("missing ?case=", { status: 400 });
    const io = { stdout: "", stderr: "" };
    const shim = wasi(["ih-stack-probe", "case", name], io);
    let instance;
    try {
      instance = await WebAssembly.instantiate(probe, { wasi_snapshot_preview1: shim.imports });
    } catch (error) {
      return new Response(`HOST ERROR: instantiate: ${error.message}`, { status: 500 });
    }
    shim.setMemory(instance.exports.memory);
    const sp = instance.exports.__stack_pointer;
    const painted = url.searchParams.get("paint") ? paint(instance) : null;
    const result = { stdout: "", stderr: "", exit: 0, trap: null, shadowStack: null,
                     shadowStackTop: sp ? sp.value : null };
    try {
      instance.exports._start();
    } catch (error) {
      if (error instanceof ProcExit) {
        result.exit = error.code;
      } else if (error instanceof RangeError || error instanceof WebAssembly.RuntimeError) {
        result.trap = error.message;
      } else {
        return new Response(`HOST ERROR: ${error && error.message ? error.message : error}`, { status: 500 });
      }
    } finally {
      if (painted) result.shadowStack = highWater(instance, painted);
    }
    shim.flush();
    result.stdout = io.stdout;
    result.stderr = io.stderr;
    return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
  },
};
