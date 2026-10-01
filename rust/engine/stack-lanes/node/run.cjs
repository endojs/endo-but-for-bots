// Run the wasm32-wasip1 probe under Node's WASI preview1, as
// scripts/test-snapshot-wasi.py does, forwarding this process's arguments and
// standard streams. Usage: node [v8 flags] run.cjs <probe.wasm> <probe args...>
// With PAINT_SHADOW_STACK=1 the shadow stack's high-water mark is printed on
// stderr as `SHADOW_STACK: <bytes>` after the run, trap or not.
//
// A trap (V8's RangeError for its host stack, WebAssembly.RuntimeError for
// unreachable or out-of-bounds) is printed as `TRAP: <message>` on stderr with
// exit 3; any other failure (a missing file, a bad module) is `HOST ERROR:`
// with exit 4, so a runner never mistakes one for a stack verdict.
// With TRAP_STACK_FRAMES=<n> the innermost n frames of a trap's stack trace
// are printed first, one `TRAP FRAME: <frame>` line each, innermost first;
// a wasm frame names its function as `wasm-function[<index>]`.
const { WASI } = require('node:wasi');
const fs = require('node:fs');

const trapStackFrames = Number(process.env.TRAP_STACK_FRAMES || 0);
if (trapStackFrames > 0) Error.stackTraceLimit = trapStackFrames;

async function main() {
  // The painter both hosts share (../shadow-paint.mjs). Only with
  // PAINT_SHADOW_STACK=1 and only when the module exports __stack_pointer.
  const { paint, highWater } = await import('../shadow-paint.mjs');
  const [wasmPath, ...args] = process.argv.slice(2);
  const wasi = new WASI({
    version: 'preview1',
    args: ['ih-stack-probe', ...args],
    env: {},
    preopens: {},
    returnOnExit: true,
  });
  const module = await WebAssembly.compile(fs.readFileSync(wasmPath));
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  let painted = null;
  try {
    const sp = instance.exports.__stack_pointer;
    if (sp) process.stderr.write(`SHADOW_STACK_TOP: ${sp.value}\n`);
    if (process.env.PAINT_SHADOW_STACK) {
      try {
        painted = paint(instance);
      } catch (error) {
        throw new HostError(`painting failed: ${error.message}`);
      }
      if (!painted) throw new HostError('the module exports no __stack_pointer to paint below');
    }
    const code = wasi.start(instance);
    process.exitCode = code;
  } catch (error) {
    report(error);
  } finally {
    if (painted) {
      process.stderr.write(`SHADOW_STACK: ${highWater(instance, painted)}\n`);
    }
  }
}

class HostError extends Error {}

function report(error) {
  const message = error && error.message ? error.message : String(error);
  if (!(error instanceof HostError) &&
      (error instanceof RangeError || error instanceof WebAssembly.RuntimeError)) {
    if (trapStackFrames > 0) {
      for (const line of String(error.stack).split('\n')) {
        const frame = line.trim();
        if (frame.startsWith('at ')) process.stderr.write(`TRAP FRAME: ${frame.slice(3)}\n`);
      }
    }
    process.stderr.write(`TRAP: ${message}\n`);
    process.exitCode = 3;
  } else {
    process.stderr.write(`HOST ERROR: ${message}\n`);
    process.exitCode = 4;
  }
}

main().catch(report);
