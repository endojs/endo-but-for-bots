// @ts-check
// M3 W3.2: the bridge behind W3.1's server over a real loopback WebSocket
// (designs/m3-interfaces.md 4.2, 17): `onSocket` hands the bridge its
// socket, the Node CapTP client signs in and calls through, a refusal keeps
// the connection, a text frame closes it. No supervisor.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { makeBridge } from '../../resources/agent-host/impl/gateway/bridge.js';
import {
  closeCodes,
  gatewayTexts,
} from '../../resources/agent-host/impl/gateway/contract-m3.js';
import { makeBootstrapFactory } from '../../resources/agent-host/impl/gateway/powers.js';
import { makeGatewayServer } from '../../resources/agent-host/impl/gateway/server.js';
import { harnessVocabulary } from '../../resources/agent-host/impl/gateway/vocabulary.js';
import { makeClient } from './_m3-captp-client.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const SECRET = ['fedcba9876543210'].join('').repeat(4);

test('sign in and call through W3.1 server and the bridge', async t => {
  const session = Far('Session', {
    /** @param {string} title */
    rename: title => title.length,
  });
  const operator = Far('Operator', { session: () => session });
  const bridge = makeBridge({
    makeBootstrap: makeBootstrapFactory({
      signIn: { matches: candidate => candidate === SECRET },
      limiter: {
        check: () => ({ ok: true }),
        failed: () => {},
        succeeded: () => {},
      },
      operator,
      live: Far('Live', {}),
      content: Far('Content', {}),
      composer: Far('Composer', {}),
      history: Far('History', {}),
    }),
    vocabulary: harnessVocabulary({ log: () => {} }),
    isLargeCall: () => false,
    log: () => {},
  });
  const server = await makeGatewayServer({
    port: 0,
    staticHandler: () => false,
    onSocket: socket => {
      bridge.connect(socket);
    },
  });
  t.teardown(() => server.close());

  const open = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      // @ts-expect-error undici's WebSocketInit accepts headers
      headers: { Origin: server.origin },
    });
    ws.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(Error('no open'));
    });
    /** @type {Promise<number>} */
    const closed = new Promise(resolve => {
      ws.onclose = event => resolve(event.code);
    });
    const client = makeClient({
      send: bytes => ws.send(/** @type {Uint8Array<ArrayBuffer>} */ (bytes)),
    });
    ws.onmessage = event => client.receive(new Uint8Array(event.data));
    return { ws, client, closed };
  };

  const { ws, client } = await open();
  const powers = await E(client.bootstrap()).fetch(SECRET);
  const presence = await E(powers.operator).session();
  t.is(await E(presence).rename('hello'), 5);
  await t.throwsAsync(() => E(presence).rename('x'.repeat(30_000)), {
    message: gatewayTexts.messageTooLarge,
  });
  t.is(await E(presence).rename('still open'), 10);
  t.is(bridge.connections(), 1);
  ws.close(1000);

  const second = await open();
  second.ws.send('a text frame');
  t.is(await second.closed, closeCodes.protocol);
});
