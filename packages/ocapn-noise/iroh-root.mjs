// @ts-nocheck
// iroh-root.mjs — a dialable ocapn-noise root node over IROH (dial-by-EndpointId, NO open TCP port).
//
// The iroh analogue of noise-root.mjs and the migration TEMPLATE for the fleet: same makeOcapnNoiseNetwork +
// makeOcapn stack (so attenuation/revocation/swissnums ride on top UNCHANGED), with the transport swapped
// from makeTcpTransport({port,host}) to makeIrohTransport({secretKey,preset}). The node binds an Iroh QUIC
// endpoint — there is NO advertised host:port, so a confined worker with open outbound egress has no
// localhost:PORT / 10.89.x.x:PORT to find; the node is reachable only by its EndpointId over an authenticated
// QUIC handshake. (See IROH-V1-DESIGN.md §2/§3, and the proven round-trip in test/iroh-captp.test.js.)
//
// Usage: node iroh-root.mjs [--seed <path>] [--alpn <id>] [--preset minimal|n0|n0-no-relay]
//   Prints ONE JSON line to stdout: { keyId, endpointId, addr, location } — the dial info a supervisor/test
//   reads. keyId + EndpointId are Ed25519 PUBLIC keys (not secrets); the seed file holds the private seed.
import '@endo/init';
import fs from 'node:fs';

import { Far } from '@endo/marshal';
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';

import { makeOcapnNoiseNetwork } from './index.js';
import { makeIrohTransport } from './src/transports/iroh.js';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const seedPath = arg('seed');
const alpn = arg('alpn') || 'field/captp/0';
const preset = arg('preset') || 'minimal';

const net = makeOcapnNoiseNetwork({ codec: cborCodec });

// Stable identity from a persisted 32-byte seed: same seed => same keyId (noise designator) AND EndpointId,
// so a cap link minted today keeps resolving across restarts (mirrors noise-root.mjs's seed persistence).
let seed;
if (seedPath && fs.existsSync(seedPath)) seed = new Uint8Array(fs.readFileSync(seedPath));
else { seed = net.generateSigningKeys().privateKey; if (seedPath) fs.writeFileSync(seedPath, Buffer.from(seed), { mode: 0o600 }); }
const keyId = net.addSigningKeys({ privateKey: seed, publicKey: undefined });

const transport = await makeIrohTransport({ secretKey: seed, alpn, preset }); // an Iroh QUIC endpoint — no host:port
await net.addTransport(transport);

// Export a root capability — the Far object a client enlivens by SturdyRef and calls. help() doubles as the
// self-describing manifest; whoami() returns the EndpointId so a caller can confirm who answered.
const locator = new Map();
locator.set('root', Far('IrohRoot', {
  help: () => 'IrohRoot (over iroh, no open TCP port): ping() -> "pong"; whoami() -> EndpointId. Reachable only by EndpointId.',
  ping: () => 'pong',
  whoami: () => transport.endpointId,
}));
// makeOcapn serves inbound CapTP sessions for the locator over the registered transport.
await makeOcapn({ codec: cborCodec, network: net, debugLabel: 'iroh-root', locator });

const loc = net.locationFor(keyId);
const hints = loc.hints || {};
const endpointId = hints['iroh:id'] || transport.endpointId;
const addr = hints['iroh:addr'] || null;
console.log(JSON.stringify({ keyId, endpointId, addr, location: loc })); // one parseable line of dial info
process.stderr.write(`iroh-root up (NO TCP port) — dial: ocapn://${keyId}.np?iroh:id=${endpointId}${addr ? `&iroh:addr=${addr}` : ''}\n`);
setInterval(() => {}, 1 << 30); // serve forever
