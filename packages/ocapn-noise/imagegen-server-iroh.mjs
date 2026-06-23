// @ts-nocheck
// imagegen-server-iroh.mjs — the GPU image-gen capability over IROH (dial-by-EndpointId, NO open TCP port).
// The iroh netlayer-swap of imagegen-server.mjs: identical makeOcapnNoiseNetwork + makeOcapn + the SAME
// imageGen cap (run/help) and chunked BytesReader; only the transport changes (makeTcpTransport → makeIrohTransport).
// Same seed ⇒ same keyId/EndpointId, so the capability's identity is preserved. (GpuLease's lease facets ride
// on this GPU function; migrating it off :8930 removes the open port. See IROH-MIGRATION.md.)
//
// Usage: node imagegen-server-iroh.mjs [--seed <file>] [--secret imageGen] [--alpn id] [--preset minimal|n0|n0-no-relay]
import '@endo/init';
import fs from 'node:fs';
import { Far } from '@endo/marshal';
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from './index.js';
import { makeIrohTransport } from './src/transports/iroh.js';
import { generate } from '/home/dan/gpu-img/gen.mjs';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const seedPath = arg('seed');
const secret = arg('secret') ?? 'imageGen';
const alpn = arg('alpn') || 'field/captp/0';
const preset = arg('preset') || 'minimal';

const net = makeOcapnNoiseNetwork({ codec: cborCodec });
let seed;
if (seedPath && fs.existsSync(seedPath)) seed = new Uint8Array(fs.readFileSync(seedPath));
else { seed = net.generateSigningKeys().privateKey; if (seedPath) fs.writeFileSync(seedPath, Buffer.from(seed), { mode: 0o600 }); }
const keyId = net.addSigningKeys({ privateKey: seed, publicKey: undefined });

const transport = await makeIrohTransport({ secretKey: seed, alpn, preset }); // iroh QUIC endpoint — no host:port
await net.addTransport(transport);

// Unchanged from imagegen-server.mjs: stream the PNG as base64 chunks (the same reader shape dialers drain).
// (Over QUIC the 65519B Noise ceiling is gone, so a future simplification can return the bytes whole — but we
// keep the chunked reader here so existing dialers work unchanged.)
const CHUNK = 32_766;
const makeBytesReader = bytes => {
  let off = 0;
  return Far('BytesReader', {
    next: async () => {
      if (off >= bytes.length) return harden({ done: true, value: '' });
      const end = Math.min(off + CHUNK, bytes.length);
      const b64 = Buffer.from(bytes.subarray(off, end)).toString('base64');
      off = end;
      return harden({ done: false, value: b64 });
    },
  });
};

const imageGen = Far('ImageGen', {
  help: () => 'run({prompt, negative?, width?, height?, steps?, seed?}) -> {info, reader}; drain reader (base64 chunks) for the PNG. A text→image on the tinix GPU (SDXL-Turbo). Served over iroh (dial-by-EndpointId, no open TCP port).',
  run: async ({ prompt, ...opts }) => {
    const r = await generate(prompt, opts);
    return harden({ info: r.info, reader: makeBytesReader(r._buf) });
  },
});

const locator = new Map();
locator.set(secret, imageGen);
await makeOcapn({ codec: cborCodec, network: net, locator, debugLabel: 'iroh-imagegen' });

const loc = net.locationFor(keyId);
const hints = loc.hints || {};
const endpointId = hints['iroh:id'] || transport.endpointId;
const addr = hints['iroh:addr'] || null;
console.log(JSON.stringify({ keyId, endpointId, addr, secret, location: loc }));
process.stderr.write(`imagegen (iroh, NO TCP port) up — vending '${secret}' — dial: ocapn://${keyId}.np?iroh:id=${endpointId}${addr ? `&iroh:addr=${addr}` : ''}\n`);
await new Promise(() => {}); // serve forever
