// OCapN-Noise-over-TCP+CBOR demo client (the "local peer").
//
// The TCP sibling of `ocapn-ws-client.mjs`: reads a server OcapnLocation
// JSON, optionally rewrites its `tcp:host` / `tcp:port` transport hints (for
// a location minted with a loopback or wildcard bind address — the Noise
// handshake authenticates the location's *designator*, which is independent
// of the transport address), opens a Noise IK session over raw TCP with
// netstring-framed CBOR, fetches a capability by swissnum, and invokes it.
// Prints a machine-readable RESULT line on stdout; diagnostics on stderr.
//
// Usage:
//   node ocapn-tcp-client.mjs <location-in-file> [swissnum] [who]
//   env TCP_HOST_OVERRIDE / TCP_PORT_OVERRIDE rewrite the tcp hints
import '@endo/init';
import fs from 'node:fs';
import { E } from '@endo/far';
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from '@endo/ocapn-noise';
import { makeTcpTransport } from '@endo/ocapn-noise/transport/tcp';

const inFile = process.argv[2];
const swissnum = process.argv[3] || 'greeter';
const who = process.argv[4] || 'minion.town';
const hostOverride = process.env.TCP_HOST_OVERRIDE;
const portOverride = process.env.TCP_PORT_OVERRIDE;
if (!inFile) {
  console.error(
    'usage: node ocapn-tcp-client.mjs <location-in-file> [swissnum] [who]',
  );
  process.exit(2);
}

const location = JSON.parse(fs.readFileSync(inFile, 'utf8'));
if (hostOverride) {
  location.hints = { ...location.hints, 'tcp:host': hostOverride };
  console.error(`[client] rewrote tcp:host hint -> ${hostOverride}`);
}
if (portOverride) {
  location.hints = { ...location.hints, 'tcp:port': portOverride };
  console.error(`[client] rewrote tcp:port hint -> ${portOverride}`);
}
harden(location);
console.error(`[client] dialing ${JSON.stringify(location)}`);

const codec = cborCodec;
const network = makeOcapnNoiseNetwork({ codec });
const signingKeys = network.generateSigningKeys();
network.addSigningKeys(signingKeys);
// Dial-only: port 0 with no listen() call, so this peer never binds.
const transport = makeTcpTransport();
await network.addTransport(transport);

const client = await makeOcapn({
  codec,
  network: /** @type {any} */ (network),
  locator: new Map(),
  debugLabel: 'local-peer-tcp',
});

const sturdyRef = client.makeSturdyRef(location, swissnum);
const cap = await client.enlivenSturdyRef(sturdyRef);
console.error(`[client] enlivened '${swissnum}'; invoking...`);
const nodeId = await E(cap).getNodeId();
const reply = await E(cap).hello(who);
console.error(`[client] getNodeId() = ${nodeId}`);
console.error(`[client] hello(${who}) = ${reply}`);
console.log(`RESULT ${JSON.stringify({ ok: true, swissnum, nodeId, reply })}`);

await client.shutdown?.();
process.exit(0);
