// OCapN-Noise-over-WebSocket demo server.
//
// Publishes a Greeter capability in an OCapN locator, listens on a loopback
// WebSocket port, and writes its OcapnLocation (designator + ws:url hint) as
// JSON so a peer can dial in, run the Noise IK handshake, and invoke the
// capability. This is the same @endo/ocapn-noise WS+Noise session layer the
// Pet Daemon's `src/networks/ocapn.js` uses; here it stands alone so the demo
// does not require the full daemon to prove the transport path end to end.
//
// Usage:
//   node ocapn-ws-server.mjs <location-out-file>
//   env DEMO_HOST (default 127.0.0.1), DEMO_PORT (default 8930)
import '@endo/init';
import fs from 'node:fs';
import * as wsmod from 'ws';
import { E, Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from '@endo/ocapn-noise';
import { makeWebSocketTransport } from '@endo/ocapn-noise/transport/ws';

const outFile = process.argv[2] || '/tmp/ocapn-demo-location.json';
const host = process.env.DEMO_HOST || '127.0.0.1';
const port = Number(process.env.DEMO_PORT || 8930);
const SWISSNUM = 'greeter';

const codec = cborCodec;
const network = makeOcapnNoiseNetwork({ codec });
const signingKeys = network.generateSigningKeys();
const keyId = network.addSigningKeys(signingKeys);
const transport = makeWebSocketTransport({
  WebSocket: /** @type {any} */ (wsmod.WebSocket),
  WebSocketServer: wsmod.WebSocketServer,
  host,
  port,
});
await network.addTransport(transport);

const GreeterInterface = M.interface('Greeter', {
  hello: M.call(M.string()).returns(M.string()),
  getNodeId: M.call().returns(M.string()),
});
const greeter = makeExo('Greeter', GreeterInterface, {
  hello: who =>
    `Hello, ${who}! — greetings over OCapN-Noise-WS from the minion.town host.`,
  getNodeId: () => keyId,
});

const locator = new Map([[SWISSNUM, greeter]]);
const client = await makeOcapn({
  codec,
  network: /** @type {any} */ (network),
  locator,
  debugLabel: 'minion-ocapn-server',
});

const location = network.locationFor(keyId);
fs.writeFileSync(outFile, `${JSON.stringify(location, null, 2)}\n`);
console.error(`[server] swissnum=${SWISSNUM} listening ws://${host}:${port}`);
console.error(`[server] location written to ${outFile}`);
console.error(`[server] location = ${JSON.stringify(location)}`);

// Keep the process alive; systemd owns the lifecycle.
await new Promise(() => {});
void E;
void Far;
