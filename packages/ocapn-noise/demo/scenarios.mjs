// Milestone 2: empirically validate the two previously-unproven handshake paths
// over a REAL transport (WebSocket/HTTP or TCP+CBOR):
//
//   (A) Reverse peer authentication — the LISTENING side authenticates the
//       DIALING side (and vice versa). We show that after a one-way dial, the
//       listener ends up holding the dialer's *cryptographically authenticated*
//       identity, even though the dialer never advertised a location to it.
//
//   (B) Crossed Hellos — both peers initiate simultaneously. We show both ends
//       converge on ONE shared session (same sessionId), exactly one side wins
//       as initiator, and the surviving channel carries traffic both ways.
//
// Each network uses a real listener/dialer transport; peers exchange only the
// data a real peer would (a location for who-to-dial, plus keyIds we happen to
// know because this harness hosts both). Diagnostics on stderr; a final
// machine-readable RESULT line on stdout.

import '@endo/init';
import * as ws from 'ws';

import { makeOcapnNoiseNetwork } from '../index.js';
import { cborCodec } from '@endo/ocapn/cbor';
import { makeWebSocketTransport } from '../src/transports/ws-node.js';
import { makeTcpTransport } from '../src/transports/tcp.js';

const scheme = process.argv[2];
if (!['ws', 'tcp'].includes(scheme)) {
  console.error('usage: node demo/scenarios.mjs <ws|tcp>');
  process.exit(2);
}

const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);
// Note: sessionId is an *immutable* ArrayBuffer; `new Uint8Array(ab)` reads it
// as length 0. `ab.slice(0)` returns a normal, readable copy. (The repo's
// crossed-hellos.test.js compares `new Uint8Array(sessionId)` directly, which
// is vacuously empty on both sides — a test-quality gap. See DEMO-REPORT.md.)
const hex = ab => {
  const u =
    ab.byteLength && new Uint8Array(ab).length === 0
      ? new Uint8Array(ab.slice(0))
      : new Uint8Array(ab);
  return [...u].map(b => b.toString(16).padStart(2, '0')).join('');
};

// A transport that both listens and dials (for symmetric peers).
const listeningTransport = () =>
  scheme === 'ws'
    ? makeWebSocketTransport({
        WebSocket: ws.WebSocket,
        WebSocketServer: ws.WebSocketServer,
        host: '127.0.0.1',
        port: 0,
      })
    : makeTcpTransport({ host: '127.0.0.1', port: 0, framing: 'netstring' });

// A dial-only transport (ws without a server cannot listen).
const dialingTransport = () =>
  scheme === 'ws'
    ? makeWebSocketTransport({ WebSocket: ws.WebSocket })
    : makeTcpTransport({ host: '127.0.0.1', port: 0, framing: 'netstring' });

const makeNet = async transport => {
  const network = makeOcapnNoiseNetwork({ codec: cborCodec });
  const keys = network.generateSigningKeys();
  const keyId = network.addSigningKeys(keys);
  await network.addTransport(transport);
  return { network, keyId };
};

let failures = 0;
const check = (label, cond) => {
  console.error(`  [${cond ? 'ok' : 'FAIL'}] ${label}`);
  if (!cond) failures += 1;
};

// ---------------------------------------------------------------------------
// (A) Reverse peer authentication
// ---------------------------------------------------------------------------
console.error(`\n=== (A) reverse peer authentication over ${scheme} ===`);
{
  const S = await makeNet(listeningTransport()); // listener
  const C = await makeNet(dialingTransport()); // dialer (no listener)
  const locS = S.network.locationFor(S.keyId);
  console.error(`  dialer keyId  = ${C.keyId}`);
  console.error(`  listener keyId= ${S.keyId}`);
  console.error(
    `  dialer knows only listener location: ${JSON.stringify(locS.hints)}`,
  );
  console.error(`  listener was told NOTHING about the dialer's address.`);

  const [sessC, sessS] = await Promise.all([
    C.network.provideSession(locS), // C dials S
    S.network.waitForInboundSession(C.keyId), // S accepts, authenticating C
  ]);

  // Forward auth: dialer authenticated the listener it meant to reach.
  check(
    'dialer authenticated listener (remote designator == listener keyId)',
    sessC.remoteLocation.designator === S.keyId,
  );
  // REVERSE auth: listener authenticated the dialer, purely from the in-band
  // identity exchange — it never had the dialer's location.
  check(
    'listener authenticated dialer (remote designator == dialer keyId)  <-- reverse',
    sessS.remoteLocation.designator === C.keyId,
  );
  check(
    'both ends agree on one sessionId',
    hex(sessC.sessionId) === hex(sessS.sessionId),
  );
  check(
    'exactly one side is the initiator',
    sessC.isInitiator !== sessS.isInitiator,
  );
  check('dialer is the initiator', sessC.isInitiator === true);

  // Prove the mutually-authenticated channel actually carries data.
  await sessC.writer.next(enc('hello-from-dialer'));
  const got = await sessS.reader.next(undefined);
  check(
    `listener received dialer's message ('${dec(got.value)}')`,
    dec(got.value) === 'hello-from-dialer',
  );

  S.network.shutdown();
  C.network.shutdown();
}

// ---------------------------------------------------------------------------
// (B) Crossed Hellos
// ---------------------------------------------------------------------------
console.error(`\n=== (B) crossed hellos over ${scheme} ===`);
{
  const A = await makeNet(listeningTransport());
  const B = await makeNet(listeningTransport());
  const locA = A.network.locationFor(A.keyId);
  const locB = B.network.locationFor(B.keyId);
  console.error(`  A keyId=${A.keyId}`);
  console.error(`  B keyId=${B.keyId}`);
  console.error(`  both call provideSession(other) simultaneously…`);

  const [sessA, sessB] = await Promise.all([
    A.network.provideSession(locB),
    B.network.provideSession(locA),
  ]);

  const sidA = hex(sessA.sessionId);
  const sidB = hex(sessB.sessionId);
  check('sessionId is a non-empty 32-byte value', sidA.length === 64);
  check(
    'A and B converge on the SAME sessionId',
    sidA === sidB && sidA.length === 64,
  );
  console.error(`    sessionId=${sidA.slice(0, 32)}…`);
  check(
    'exactly one side won as initiator',
    sessA.isInitiator !== sessB.isInitiator,
  );
  console.error(
    `    A.isInitiator=${sessA.isInitiator}  B.isInitiator=${sessB.isInitiator}`,
  );
  check('A authenticated B', sessA.remoteLocation.designator === B.keyId);
  check('B authenticated A', sessB.remoteLocation.designator === A.keyId);

  // The single surviving channel must carry traffic both directions.
  await sessA.writer.next(enc('ping-from-A'));
  const atB = await sessB.reader.next(undefined);
  check(
    `B received A's ping ('${dec(atB.value)}')`,
    dec(atB.value) === 'ping-from-A',
  );
  await sessB.writer.next(enc('pong-from-B'));
  const atA = await sessA.reader.next(undefined);
  check(
    `A received B's pong ('${dec(atA.value)}')`,
    dec(atA.value) === 'pong-from-B',
  );

  A.network.shutdown();
  B.network.shutdown();
}

console.error('');
if (failures === 0) {
  console.log(
    `RESULT: PASS (${scheme}) — reverse peer auth and crossed hellos validated`,
  );
  process.exit(0);
} else {
  console.log(`RESULT: FAIL (${scheme}) — ${failures} check(s) failed`);
  process.exit(1);
}
