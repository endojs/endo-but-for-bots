// OCapN-Noise-over-TCP+CBOR demo server.
//
// The TCP+CBOR (netstring-framed) sibling of `ocapn-ws-server.mjs`: publishes
// a Greeter capability, listens on a TCP port, and writes its OcapnLocation
// (designator + tcp:host/tcp:port hints) as JSON so a peer can dial in, run
// the Noise IK handshake, and invoke the capability. Unlike the WS variant —
// which hides behind Caddy TLS on 443 — a raw TCP listener cannot ride the
// HTTPS port, so the deployment binds a dedicated public port opened in the
// host's security group (maintainer-authorized). The Noise handshake is the
// authentication layer; the port exposes nothing unkeyed.
//
// Usage:
//   node ocapn-tcp-server.mjs <location-out-file>
//   env DEMO_HOST (default 127.0.0.1), DEMO_PORT (default 8929)
//   env DEMO_PUBLIC_HOST / DEMO_PUBLIC_PORT: advertise these in the written
//   location instead of the bind address (a 0.0.0.0 bind is not dialable),
//   so the location file is directly usable by a remote peer with no
//   client-side hint rewrite.
import '@endo/init';
import fs from 'node:fs';
import { E, Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from '@endo/ocapn-noise';
import { makeTcpTransport } from '@endo/ocapn-noise/transport/tcp';

const outFile = process.argv[2] || '/tmp/ocapn-tcp-location.json';
const host = process.env.DEMO_HOST || '127.0.0.1';
const port = Number(process.env.DEMO_PORT || 8929);
const publicHost = process.env.DEMO_PUBLIC_HOST;
const publicPort = process.env.DEMO_PUBLIC_PORT;
const SWISSNUM = 'greeter';

const codec = cborCodec;
const network = makeOcapnNoiseNetwork({ codec });
const signingKeys = network.generateSigningKeys();
const keyId = network.addSigningKeys(signingKeys);
const transport = makeTcpTransport({ host, port });
await network.addTransport(transport);

const GreeterInterface = M.interface('Greeter', {
  hello: M.call(M.string()).returns(M.string()),
  getNodeId: M.call().returns(M.string()),
});
const greeter = makeExo('Greeter', GreeterInterface, {
  hello: who =>
    `Hello, ${who}! — greetings over OCapN-Noise-TCP+CBOR from the minion.town host.`,
  getNodeId: () => keyId,
});

const locator = new Map([[SWISSNUM, greeter]]);
const client = await makeOcapn({
  codec,
  network: /** @type {any} */ (network),
  locator,
  debugLabel: 'minion-ocapn-tcp-server',
});

const bound = network.locationFor(keyId);
const hints = { ...bound.hints };
if (publicHost) hints['tcp:host'] = publicHost;
if (publicPort) hints['tcp:port'] = publicPort;
const location = { ...bound, hints };
fs.writeFileSync(outFile, `${JSON.stringify(location, null, 2)}\n`);
console.error(`[server] swissnum=${SWISSNUM} listening tcp://${host}:${port}`);
console.error(`[server] location written to ${outFile}`);
console.error(`[server] location = ${JSON.stringify(location)}`);

// Keep the process alive; systemd owns the lifecycle.
await new Promise(() => {});
void E;
void Far;
void client;
