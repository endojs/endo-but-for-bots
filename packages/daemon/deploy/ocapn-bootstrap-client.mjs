// OCapN-Noise-over-WebSocket peer that reaches the FULL Pet Daemon's bootstrap.
//
// Reads the daemon's OcapnLocation JSON (written by daemon-ocapn-ws-boot.mjs),
// optionally rewrites its `ws:url` transport hint to a public `wss://` endpoint
// (the daemon binds a loopback WS port reachable only through Caddy TLS; the
// Noise handshake authenticates the location's *designator*, independent of the
// transport URL), opens a Noise IK session, fetches the daemon's
// `EndoOcapnBootstrap` by its well-known swissnum `endo-bootstrap`, and invokes
// it. Prints a machine-readable RESULT line on stdout; diagnostics on stderr.
//
// Usage:
//   node ocapn-bootstrap-client.mjs <location-in-file> [swissnum]
//   env WS_URL_OVERRIDE (e.g. wss://minion.town/ocapn-daemon) rewrites ws:url
import '@endo/init';
import fs from 'node:fs';
import * as wsmod from 'ws';
import { E } from '@endo/far';
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from '@endo/ocapn-noise';
import { makeWebSocketTransport } from '@endo/ocapn-noise/transport/ws';

const inFile = process.argv[2];
const swissnum = process.argv[3] || 'endo-bootstrap';
const urlOverride = process.env.WS_URL_OVERRIDE;
if (!inFile) {
  console.error(
    'usage: node ocapn-bootstrap-client.mjs <location-in-file> [swissnum]',
  );
  process.exit(2);
}

const location = JSON.parse(fs.readFileSync(inFile, 'utf8'));
if (urlOverride) {
  location.hints = { ...location.hints, 'ws:url': urlOverride };
  console.error(`[peer] rewrote ws:url hint -> ${urlOverride}`);
}
harden(location);
console.error(`[peer] dialing ${JSON.stringify(location)}`);

const codec = cborCodec;
const network = makeOcapnNoiseNetwork({ codec });
const signingKeys = network.generateSigningKeys();
network.addSigningKeys(signingKeys);
// Dial-only: no WebSocketServer, so this peer only connects out.
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
const bootstrap = await client.enlivenSturdyRef(sturdyRef);
console.error(
  `[peer] enlivened '${swissnum}' (EndoOcapnBootstrap); invoking...`,
);

const nodeId = await E(bootstrap).getNodeId();
const help = await E(bootstrap).help();
const binding = await E(bootstrap).getAgentBinding();
console.error(`[peer] getNodeId() = ${nodeId}`);
console.error(`[peer] help() = ${help}`);
console.error(
  `[peer] getAgentBinding().agentPublicKey = ${binding.agentPublicKey}`,
);
// getGreeter() returns the EndoGreeter that runs the peer `hello` handshake —
// reaching it proves the bootstrap hands back the live peer-protocol entry.
const greeter = await E(bootstrap).getGreeter();
console.error(
  `[peer] getGreeter() -> ${greeter ? 'EndoGreeter present' : 'MISSING'}`,
);

console.log(
  `RESULT ${JSON.stringify({
    ok: true,
    swissnum,
    nodeId,
    agentPublicKey: binding.agentPublicKey,
    hasGreeter: Boolean(greeter),
  })}`,
);

await client.shutdown?.();
process.exit(0);
