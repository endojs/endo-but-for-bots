// Survey perf probe: raw Ironhorse engine costs and guest JS surface, one fresh vat per probe.
const PKG =
  '/Users/xyz/Development/endo-thixotrope-harness/packages/thixotrope';
await import(`${PKG}/node_modules/@endo/init/index.js`);
const { rm, mkdir } = await import('node:fs/promises');
const { join } = await import('node:path');
const { performance } = await import('node:perf_hooks');
const { execSync } = await import('node:child_process');
const { makeTcpNetLayer } = await import(
  `${PKG}/node_modules/@endo/ocapn/src/netlayers/tcp-test-only.js`
).catch(() => import(`${PKG}/node_modules/@endo/ocapn/netlayer/tcp-testing`));
const { syrupCodec } = await import(
  `${PKG}/node_modules/@endo/ocapn/src/syrup/index.js`
).catch(() => import(`${PKG}/node_modules/@endo/ocapn/syrup`));
const { makeThixotropeDaemon } = await import(`${PKG}/src/core/daemon.js`);
const { makeIronhorseEngine } = await import(
  `${PKG}/src/ironhorse/ironhorse-engine.js`
);
const { makeFsStore } = await import(`${PKG}/src/store/store-fs.js`);
const { makeNodePowers } = await import(`${PKG}/src/platform/node/powers.js`);

const powers = makeNodePowers();
const statePath = `${PKG}/tmp/cq`;
await rm(statePath, { recursive: true, force: true });
await mkdir(statePath, { recursive: true });
const store = makeFsStore(powers, statePath);
const engine = makeIronhorseEngine(powers, {
  workerBinary: `${PKG}/../../target/release/thixotrope-ironhorse-worker`,
  bootPaths: ['boot.js', 'worker-peer.js'].map(n =>
    join(PKG, 'dist-ironhorse', n),
  ),
  storePath: join(statePath, 'heaps'),
});
const ms = t0 => `${(performance.now() - t0).toFixed(1)}ms`;
let t0 = performance.now();
const daemon = await makeThixotropeDaemon(powers, {
  store,
  engine,
  codec: syrupCodec,
  makeNetlayer: ({ handlers, logger }) => makeTcpNetLayer({ handlers, logger }),
});
console.log('daemon start (empty store):', ms(t0));
const { E } = await import(`${PKG}/node_modules/@endo/far/src/index.js`);
process.on('unhandledRejection', e => console.log('unhandled', e?.message));
const fresh = async label => {
  const w = await daemon.createWorker({ debugLabel: label });
  const t = await w.evaluate(
    "Far('T', { len: a => Array.isArray(a) ? a.reduce((n, s) => n + s.length, 0) : a.length, make: n => 'x'.repeat(n), makeArr: (n, k) => harden(Array.from({length: k}, () => 'y'.repeat(n))) })",
  );
  return { w, t };
};
const run = async (label, f) => {
  const t0 = performance.now();
  let r;
  try {
    r = await f();
  } catch (e) {
    r = 'ERR ' + e.message;
  }
  console.log(
    JSON.stringify({
      label,
      ms: Math.round(performance.now() - t0),
      r: String(r).slice(0, 160),
    }),
  );
};

const B64 = `(n) => { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; const monodu64 = {}; for (let i = 0; i < 64; i += 1) monodu64[alphabet[i]] = i; const string = 'QUFB'.repeat(Math.ceil(n / 3)); const data = new Uint8Array(Math.ceil((string.length * 3) / 4)); let register = 0, quantum = 0, i = 0, j = 0; while (i < string.length && string[i] !== '=') { const number = monodu64[string[i]]; register = (register << 6) | number; quantum += 6; if (quantum >= 8) { quantum -= 8; data[j] = register >>> quantum; j += 1; register &= (1 << quantum) - 1; } i += 1; } return j; }`;
const DEC = `(n) => { const bytes = new Uint8Array(n).fill(65); const parts = []; const units = []; let i = 0; while (i < bytes.length) { const b0 = bytes[i]; let code; if (b0 < 0x80) { code = b0; i += 1; } else { code = 0xfffd; i += 1; } units.push(code); if (units.length === 4096) { parts.push(String.fromCharCode.apply(null, units)); units.length = 0; } } parts.push(String.fromCharCode.apply(null, units)); return parts.join('').length; }`;
for (const n of [98304, 131072, 196608]) {
  const w = await daemon.createWorker({ debugLabel: 'b64' });
  await run(`in-vat js base64 decode ${n} bytes`, () =>
    w.evaluate(`(${B64})(${n})`),
  );
}
for (const n of [98304, 131072, 196608]) {
  const w = await daemon.createWorker({ debugLabel: 'dec' });
  await run(`in-vat linear utf8 decode ${n} bytes`, () =>
    w.evaluate(`(${DEC})(${n})`),
  );
}
await daemon.shutdown?.();
await rm(statePath, { recursive: true, force: true });
console.log('done');
process.exit(0);
