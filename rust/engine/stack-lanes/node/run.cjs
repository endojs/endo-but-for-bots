// Run the wasm32-wasip1 probe under Node's WASI preview1, as
// scripts/test-snapshot-wasi.py does, forwarding this process's arguments and
// standard streams. Usage: node [v8 flags] run.cjs <probe.wasm> <probe args...>
//
// A trap (V8's RangeError for its host stack, WebAssembly.RuntimeError for
// unreachable or out-of-bounds) is printed as `TRAP: <message>` on stderr with
// exit 3; any other failure (a missing file, a bad module) is `HOST ERROR:`
// with exit 4, so a runner never mistakes one for a stack verdict.
const { WASI } = require('node:wasi');
const fs = require('node:fs');

async function main() {
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
  try {
    const code = wasi.start(instance);
    process.exitCode = code;
  } catch (error) {
    report(error);
  }
}

function report(error) {
  const message = error && error.message ? error.message : String(error);
  if (error instanceof RangeError || error instanceof WebAssembly.RuntimeError) {
    process.stderr.write(`TRAP: ${message}\n`);
    process.exitCode = 3;
  } else {
    process.stderr.write(`HOST ERROR: ${message}\n`);
    process.exitCode = 4;
  }
}

main().catch(report);
