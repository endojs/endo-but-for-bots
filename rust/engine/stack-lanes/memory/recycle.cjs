// Time what re-instantiating the memory probe costs under Node's V8, the
// engine workerd embeds: compile the module, instantiate it, and resume a saved
// snapshot and run one crank in the fresh instance (the probe's `restore`).
// Usage: node --liftoff-only --experimental-wasm-exnref recycle.cjs <probe.wasm> <snapshot>
// Prints the probe's own line, then one JSON line of timings.
const { WASI } = require('node:wasi');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const [wasmPath, snapshot] = process.argv.slice(2);
  const dir = path.dirname(path.resolve(snapshot));
  const bytes = fs.readFileSync(wasmPath);
  const before = process.memoryUsage();
  const t0 = performance.now();
  const module = await WebAssembly.compile(bytes);
  const t1 = performance.now();
  const wasi = new WASI({
    version: 'preview1',
    args: ['ih-memory-probe', 'restore', path.resolve(snapshot)],
    env: {},
    preopens: { [dir]: dir },
    returnOnExit: true,
  });
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  const t2 = performance.now();
  const instantiated = process.memoryUsage();
  const code = wasi.start(instance);
  const t3 = performance.now();
  if (code !== 0) throw Error(`the probe exited ${code}`);
  const timings = {
    compile_ms: t1 - t0,
    instantiate_ms: t2 - t1,
    run_ms: t3 - t2,
    linear_mb: instance.exports.memory.buffer.byteLength / 1e6,
    rss_mb: process.memoryUsage().rss / 1e6,
    // What the host holds besides the vat's linear memory once the module is
    // compiled and instantiated: V8's JS heap and the process's resident set
    // past the fresh instance's linear memory (compiled code among it).
    js_heap_mb: instantiated.heapUsed / 1e6,
    rss_before_mb: before.rss / 1e6,
    rss_instantiated_mb: instantiated.rss / 1e6,
  };
  process.stdout.write(`${JSON.stringify(timings)}\n`);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
