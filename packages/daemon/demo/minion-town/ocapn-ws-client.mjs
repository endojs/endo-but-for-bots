// OCapN-Noise-over-WebSocket demo client (the "local peer").
//
// Reads a server OcapnLocation JSON, optionally rewrites its `ws:url`
// transport hint to a public wss:// endpoint (so a loopback-bound listener
// reachable only through a Caddy TLS reverse-proxy can still be dialed — the
// Noise handshake authenticates the location's *designator*, which is
// independent of the transport URL), opens a Noise IK session, fetches a
// capability by swissnum, and invokes it. Prints a machine-readable RESULT
// line on stdout; diagnostics on stderr.
//
// Usage:
//   node ocapn-ws-client.mjs <location-in-file> [swissnum] [who]
//   env WS_URL_OVERRIDE (e.g. wss://minion.town/ocapn) rewrites the ws:url hint
import '@endo/init';
import fs from 'node:fs';
import * as wsmod from 'ws';
import { E } from '@endo/far';
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from '@endo/ocapn-noise';
import { makeWebSocketTransport } from '@endo/ocapn-noise/transport/ws';

const inFile = process.argv[2];
const swissnum = process.argv[3] || 'greeter';
const who = process.argv[4] || 'minion.town';
const urlOverride = process.env.WS_URL_OVERRIDE;
if (!inFile) {
  console.error(
    'usage: node ocapn-ws-client.mjs <location-in-file> [swissnum] [who]',
  );
  process.exit(2);
}

const location = JSON.parse(fs.readFileSync(inFile, 'utf8'));
if (urlOverride) {
  location.hints = { ...location.hints, 'ws:url': urlOverride };
  console.error(`[client] rewrote ws:url hint -> ${urlOverride}`);
}
harden(location);
console.error(`[client] dialing ${JSON.stringify(location)}`);

const codec = cborCodec;
const network = makeOcapnNoiseNetwork({ codec });
const signingKeys = network.generateSigningKeys();
network.addSigningKeys(signingKeys);
// Dial-only: no WebSocketServer, so this peer cannot listen.
const transport = makeWebSocketTransport({
  WebSocket: /** @type {any} */ (wsmod.WebSocket),
});
await network.addTransport(transport);

const client = await makeOcapn({
  codec,
  network: /** @type {any} */ (network),
  locator: new Map(),
  debugLabel: 'local-peer',
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
