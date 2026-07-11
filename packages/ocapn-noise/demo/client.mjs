// Toy OCapN-over-Noise client: dials the server, runs Noise IK, invokes Greeter.
//
// Usage: node demo/client.mjs <ws|tcp> <location-in-file> [who]
//
// Reads the server's OcapnLocation JSON, opens a Noise session over the named
// transport, fetches the 'Greeter' capability via a SturdyRef, and calls
// hello(who). Prints the reply on stdout; diagnostics on stderr.

import '@endo/init';
import fs from 'node:fs';
import * as ws from 'ws';

import { E, makeNoisePeer } from './peer.mjs';
import { makeWebSocketTransport } from '../src/transports/ws-node.js';
import { makeTcpTransport } from '../src/transports/tcp.js';

const scheme = process.argv[2];
const inFile = process.argv[3];
const who = process.argv[4] || 'Alice';
if (!['ws', 'tcp'].includes(scheme) || !inFile) {
  console.error('usage: node demo/client.mjs <ws|tcp> <location-in-file> [who]');
  process.exit(2);
}

const serverLocation = harden(JSON.parse(fs.readFileSync(inFile, 'utf8')));
console.error(`[client:${scheme}] dialing ${JSON.stringify(serverLocation)}`);

// Dial-only transport. (For ws we omit WebSocketServer so it cannot listen.)
const transport =
  scheme === 'ws'
    ? makeWebSocketTransport({ WebSocket: ws.WebSocket })
    : makeTcpTransport({ host: '127.0.0.1', port: 0, framing: 'netstring' });

const peer = await makeNoisePeer({ name: 'client', transport });
console.error(`[client:${scheme}] keyId=${peer.keyId}`);

const sturdyRef = peer.client.makeSturdyRef(serverLocation, 'Greeter');
const greeter = await peer.client.enlivenSturdyRef(sturdyRef);
console.error(`[client:${scheme}] enlivened Greeter; sending hello(${who})…`);

const reply = await E(greeter).hello(who);
console.error(`[client:${scheme}] reply = ${JSON.stringify(reply)}`);
console.log(reply);

await peer.client.shutdown?.();
process.exit(0);
