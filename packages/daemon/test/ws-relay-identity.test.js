// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';
import { makePipe } from '@endo/stream';
import { WebSocketServer } from 'ws';
import {
  MSG_HELLO,
  MSG_DATA,
  MSG_CLOSE,
  decodeFrame,
  decodeDataFrame,
  encodeAuthOk,
  encodeIncoming,
  encodeData,
} from '@endo/relay-server/protocol.js';

import { makeNetstringCapTP } from '../src/connection.js';
import { make } from '../src/networks/ws-relay.js';

/** @import { Writer } from '@endo/stream' */

test.serial(
  'relay greeting must match authenticated channel sender',
  async t => {
    t.timeout(5000);
    const localNodeId = '11'.repeat(32);
    const authenticatedNodeId = '22'.repeat(32);
    const victimNodeId = '33'.repeat(32);
    const channelId = 1;
    const cancellation = makePromiseKit();
    cancellation.promise.catch(() => {});
    const connected = makePromiseKit();
    const [reader, sink] = makePipe();
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    /** @type {Promise<void> | undefined} */
    let disposed;
    t.teardown(async () => {
      cancellation.reject(new Error('Test complete'));
      await sink.return(undefined);
      for (const client of server.clients) client.terminate();
      await new Promise(resolve => server.close(resolve));
      await disposed;
    });

    server.on('connection', socket => {
      connected.resolve(socket);
      socket.on('message', raw => {
        const { type, payload } = decodeFrame(
          new Uint8Array(/** @type {ArrayBuffer} */ (raw)),
        );
        if (type === MSG_HELLO) socket.send(encodeAuthOk());
        if (type === MSG_DATA) {
          const { data } = decodeDataFrame(payload);
          sink.next(data).catch(() => {});
        }
        if (type === MSG_CLOSE) sink.return(undefined).catch(() => {});
      });
      socket.on('close', () => sink.return(undefined).catch(() => {}));
    });
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
      throw new Error('Expected assigned relay port');
    }

    /** @type {unknown[][]} */
    const greetings = [];
    const retentionQueries = [];
    const gateway = Far('TestGateway', {
      provide: () => 'granted',
      provideBlob: hash => `blob:${hash}`,
      provideTree: hash => `tree:${hash}`,
      followRetentionSet: node => {
        retentionQueries.push(node);
        return 'retention';
      },
    });
    const greeter = Far('TestGreeter', {
      hello: (...args) => {
        greetings.push(args);
        return gateway;
      },
    });
    const powers = Far('TestPowers', {
      getPeerInfo: () => harden({ node: localNodeId }),
      greeter: () => greeter,
      gateway: () => gateway,
    });
    const context = Far('TestContext', {
      whenCancelled: () => cancellation.promise,
      addDisposalHook: hook => {
        disposed = hook();
      },
    });
    await make(powers, context, {
      env: {
        WS_RELAY_URL: `ws://127.0.0.1:${address.port}`,
        WS_RELAY_DOMAIN: 'test.invalid',
      },
    });
    const socket = await connected.promise;
    // Supply the relay's authenticated channel identity, then send a forged
    // greeting over the actual netstring/CapTP adapter. The test relay omits
    // signature negotiation; this regression targets binding its result.
    socket.send(encodeIncoming(channelId, new Uint8Array(32).fill(0x22)));
    /** @type {Writer<Uint8Array>} */
    const writer = harden({
      next: async bytes => {
        socket.send(encodeData(channelId, bytes));
        return harden({ done: false, value: undefined });
      },
      return: async () => {
        socket.close();
        return harden({ done: true, value: undefined });
      },
      throw: async () => {
        socket.close();
        return harden({ done: true, value: undefined });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    });
    const connection = makeNetstringCapTP(
      'Relay identity regression',
      writer,
      reader,
      cancellation.promise,
      undefined,
      { onReject: () => {} },
    );
    const remoteGreeter = connection.getBootstrap();
    const remoteGateway = Far('RemoteGateway', {});
    const cancel = Far('Cancel', () => {});
    await t.throwsAsync(
      () =>
        E(remoteGreeter).hello(
          victimNodeId,
          remoteGateway,
          cancel,
          cancellation.promise,
        ),
      { message: /does not match authenticated sender/ },
    );
    t.is(
      greetings.length,
      0,
      'forged greeting never reaches daemon peer state',
    );
    const acceptedGateway = await E(remoteGreeter).hello(
      authenticatedNodeId,
      remoteGateway,
      cancel,
      cancellation.promise,
    );
    t.is(await E(acceptedGateway).provide('test'), 'granted');
    t.is(await E(acceptedGateway).provideBlob('test'), 'blob:test');
    t.is(await E(acceptedGateway).provideTree('test'), 'tree:test');
    await t.throwsAsync(
      () => E(acceptedGateway).followRetentionSet(victimNodeId),
      { message: /Cannot follow retention for another peer/ },
    );
    t.deepEqual(
      retentionQueries,
      [],
      'other peers cannot reveal retained bearer IDs',
    );
    t.is(
      await E(acceptedGateway).followRetentionSet(authenticatedNodeId),
      'retention',
    );
    t.deepEqual(retentionQueries, [authenticatedNodeId]);
    t.is(greetings.length, 1);
    t.is(greetings[0][0], authenticatedNodeId);
  },
);
