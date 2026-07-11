// Toy OCapN-over-Noise server: publishes a Greeter capability and listens.
//
// Usage: node demo/server.mjs <ws|tcp> <location-out-file>
//   env DEMO_HOST (default 0.0.0.0 for ws/tcp listen), DEMO_PORT (default 0 = OS-assigned)
//
// Writes its OcapnLocation (designator + transport hints) as JSON to the given
// file once listening, then serves until killed. A client reads that file to
// dial in, run the Noise IK handshake, and invoke the Greeter capability.

import '@endo/init';
import fs from 'node:fs';
import * as ws from 'ws';

import { Far, makeNoisePeer } from './peer.mjs';
import { makeWebSocketTransport } from '../src/transports/ws-node.js';
import { makeTcpTransport } from '../src/transports/tcp.js';

const scheme = process.argv[2];
const outFile = process.argv[3];
if (!['ws', 'tcp'].includes(scheme) || !outFile) {
  console.error('usage: node demo/server.mjs <ws|tcp> <location-out-file>');
  process.exit(2);
}
const host = process.env.DEMO_HOST || '0.0.0.0';
const port = Number(process.env.DEMO_PORT || 0);

const transport =
  scheme === 'ws'
    ? makeWebSocketTransport({
        WebSocket: ws.WebSocket,
        WebSocketServer: ws.WebSocketServer,
        host,
        port,
      })
    : makeTcpTransport({ host, port, framing: 'netstring' });

const locator = new Map();
locator.set(
  'Greeter',
  Far('Greeter', {
    hello: (who = 'world') => `hello, ${who}`,
    help: () => 'Greeter: call hello(name) to be greeted.',
  }),
);

const peer = await makeNoisePeer({ name: 'server', transport, locator });

const location = peer.location;
fs.writeFileSync(outFile, JSON.stringify(location, null, 2));
console.error(`[server:${scheme}] keyId=${peer.keyId}`);
console.error(`[server:${scheme}] location=${JSON.stringify(location)}`);
console.error(`[server:${scheme}] wrote location to ${outFile} — serving.`);

// Serve until the parent kills us.
process.on('SIGTERM', () => {
  console.error(`[server:${scheme}] SIGTERM — shutting down.`);
  peer.client.shutdown?.();
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
