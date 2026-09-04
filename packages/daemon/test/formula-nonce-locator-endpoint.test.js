// @ts-nocheck
import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';
import { syrupCodec } from '@endo/ocapn/syrup';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { makeFormulaNonceLocator } from '../src/networks/formula-nonce-locator.js';
import { netListenAllowed } from './_net-permission.js';

// This suite is the daemon's first loopback-*listening* test: every case
// binds a TCP netlayer. A sandboxed checkout that forbids `listen(0)`
// should skip rather than fail, so gate on the same probe the rest of the
// daemon suite uses for its listeners.
const netTest = netListenAllowed ? test : test.skip;

const localNode = 'b'.repeat(64);
const formulaNumber = 'a'.repeat(64);
const guestId = `${formulaNumber}:${localNode}`;
const foreignId = `${formulaNumber}:${'c'.repeat(64)}`;

// Poll a predicate until it holds or the budget runs out. Used to await a
// transport severance that propagates across the loopback socket
// asynchronously (the abort is deferred a turn on the far side and the
// socket close is itself async).
const waitFor = async (predicate, { tries = 200, delayMs = 10 } = {}) => {
  for (let i = 0; i < tries; i += 1) {
    if (predicate()) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
};

const codecs = [
  ['syrup', syrupCodec],
  ['cbor', cborCodec],
];

// Build one OCapN client over the test TCP netlayer. The mechanism is
// transport-agnostic: this exercises the same injected-locator seam that
// a Noise/WebSocket deployment uses, with the codec chosen up front
// (never negotiated on the wire), exactly as the two well-known routes
// choose it. `makeLocatorForSession` (when given) scopes miss counters
// to each authenticated peer.
const makeClient = async ({
  codec,
  designator,
  locator,
  makeLocatorForSession,
}) => {
  const netlayerHolder = {};
  const client = await makeOcapn({
    codec,
    debugLabel: designator,
    debugMode: true,
    locator,
    makeLocatorForSession,
    network: (handlers, logger) =>
      makeTcpNetLayer({
        handlers,
        logger,
        specifiedDesignator: designator,
      }).then(netlayer => {
        netlayerHolder.netlayer = netlayer;
        return netlayer;
      }),
  });
  return { client, location: netlayerHolder.netlayer.location };
};

for (const [codecName, codec] of codecs) {
  netTest(
    `[${codecName}] a local guest formula fetches the guest capability, not host/gateway`,
    async t => {
      const guest = Far('Guest', {
        greet: name => `hello ${name} from the guest`,
      });
      const locator = makeFormulaNonceLocator({
        provideLocalFormula: async (id, node) => {
          t.is(
            id,
            guestId,
            'the presented identifier reaches provide verbatim',
          );
          t.is(node, localNode);
          return guest;
        },
        localNodeNumber: localNode,
      });

      const server = await makeClient({
        codec,
        designator: `server-${codecName}`,
        makeLocatorForSession: locator.makeLocatorForSession,
      });
      const client = await makeClient({
        codec,
        designator: `client-${codecName}`,
        locator: new Map(),
      });

      const sturdyRef = client.client.makeSturdyRef(server.location, guestId);
      const fetched = await client.client.enlivenSturdyRef(sturdyRef);

      // The fetched surface is the guest's — its own method resolves...
      t.is(
        await E(fetched).greet('friend'),
        'hello friend from the guest',
        'guest method is reachable',
      );
      // ...and it is not the protocol bootstrap or a gateway: a method
      // that only those would carry is absent.
      await t.throwsAsync(
        () => E(fetched).fetch(guestId),
        undefined,
        'no bootstrap fetch on the guest',
      );
      await t.throwsAsync(
        () => E(fetched).provide(guestId),
        undefined,
        'no gateway provide on the guest',
      );

      client.client.shutdown();
      server.client.shutdown();
    },
  );

  netTest(
    `[${codecName}] every miss class produces the same peer-visible rejection`,
    async t => {
      // The locator provides only the one guest; every other presentation
      // must be an indistinguishable miss.
      const guest = Far('Guest', { greet: () => 'hi' });
      const locator = makeFormulaNonceLocator({
        provideLocalFormula: async id => {
          if (id === guestId) return guest;
          // Absent / never-formulated: the real daemon path rejects here.
          throw new ReferenceError(`No formula exists for number ${id}`);
        },
        localNodeNumber: localNode,
      });
      const server = await makeClient({
        codec,
        designator: `server2-${codecName}`,
        makeLocatorForSession: locator.makeLocatorForSession,
      });
      const client = await makeClient({
        codec,
        designator: `client2-${codecName}`,
        locator: new Map(),
      });

      const missSecrets = [
        'not-a-formula-identifier', // malformed ASCII
        `${formulaNumber.toUpperCase()}:${localNode}`, // noncanonical
        foreignId, // foreign node
        `${'d'.repeat(64)}:${localNode}`, // absent local formula
        'endo-bootstrap', // well-known word, not a formula identifier
        'endo-peer-entry', // live peer-entry swissnum, not a formula identifier
      ];

      const messages = [];
      for (const secret of missSecrets) {
        const sturdyRef = client.client.makeSturdyRef(server.location, secret);
        // eslint-disable-next-line no-await-in-loop
        const error = await t.throwsAsync(() =>
          client.client.enlivenSturdyRef(sturdyRef),
        );
        messages.push(error.message);
      }

      // The equivalence is the security property: not "each threw", but
      // "all threw the identical message", so no miss class is an oracle.
      const [first, ...rest] = messages;
      for (const message of rest) {
        t.is(message, first, 'all miss classes share one rejection message');
      }
      // And the message names nothing about the presentation.
      for (const secret of missSecrets) {
        if (typeof secret === 'string' && secret !== 'endo-bootstrap') {
          t.false(
            first.includes(secret),
            'the rejection never echoes the presented secret',
          );
        }
      }

      // A valid presentation on the same locator still succeeds, proving
      // the misses were genuine misses and not a dead locator.
      const goodRef = client.client.makeSturdyRef(server.location, guestId);
      const good = await client.client.enlivenSturdyRef(goodRef);
      t.is(await E(good).greet(), 'hi');

      client.client.shutdown();
      server.client.shutdown();
    },
  );

  netTest(
    `[${codecName}] completing a session without fetch grants no application capability`,
    async t => {
      const guest = Far('Guest', { greet: () => 'hi' });
      const locator = makeFormulaNonceLocator({
        provideLocalFormula: async () => guest,
        localNodeNumber: localNode,
      });
      const server = await makeClient({
        codec,
        designator: `server3-${codecName}`,
        makeLocatorForSession: locator.makeLocatorForSession,
      });
      const client = await makeClient({
        codec,
        designator: `client3-${codecName}`,
        locator: new Map(),
      });

      // Open a session (connect) but never fetch. The only thing the peer
      // exposes at export position 0 is the protocol bootstrap; it carries
      // no guest method, so connecting alone yields nothing applicative.
      // eslint-disable-next-line no-underscore-dangle
      const session = await client.client._debug.provideInternalSession(
        server.location,
      );
      const bootstrap = session.ocapn.getRemoteBootstrap();
      await t.throwsAsync(
        () => E(bootstrap).greet(),
        undefined,
        'the bootstrap has no guest method; the session conveys no application capability',
      );

      client.client.shutdown();
      server.client.shutdown();
    },
  );
}

netTest(
  'the per-session miss bound severs the abusive session over the wire, but not a valid peer',
  async t => {
    const guest = Far('Guest', { greet: () => 'hi' });
    const missBound = 3;
    const locator = makeFormulaNonceLocator({
      provideLocalFormula: async id => {
        if (id === guestId) return guest;
        throw new ReferenceError('absent');
      },
      localNodeNumber: localNode,
      missBound,
    });
    const server = await makeClient({
      codec: syrupCodec,
      designator: 'server-bound',
      makeLocatorForSession: locator.makeLocatorForSession,
    });
    const prober = await makeClient({
      codec: syrupCodec,
      designator: 'prober',
      locator: new Map(),
    });
    const holder = await makeClient({
      codec: syrupCodec,
      designator: 'holder',
      locator: new Map(),
    });

    // Hold ONE prober session explicitly so the severance assertion targets
    // a single transport rather than whatever a reconnect might mint. This
    // is the assertion the previous test could not make: it wrapped the
    // locator's `abortSession` and counted its own callback, which only
    // proved the locator *called* its callback — exactly what the unit test
    // already proves — and could not see whether the ocapn client actually
    // severed the connection. A mechanism that only deregistered the session
    // (bookkeeping-only `endSession`, with `core.abort()` stubbed out) would
    // pass a callback-counting test yet leave the socket alive. We instead
    // assert the prober's own connection is destroyed once the bound is
    // crossed — which only a real transport severance produces.
    // eslint-disable-next-line no-underscore-dangle
    const proberSession = await prober.client._debug.provideInternalSession(
      server.location,
    );

    // The prober misses repeatedly on the held session. Probes below the
    // bound (1..missBound-1) are the identical uniform rejection over the
    // wire; the bound-crossing miss severs the session. We assert
    // uniformity of the below-bound misses (no oracle) and severance at the
    // crossing (below), not that the crossing reply is byte-identical, which
    // would rest on engine-dependent teardown ordering.
    const missId = `${'e'.repeat(64)}:${localNode}`;
    const proberMessages = [];
    for (let i = 0; i < missBound; i += 1) {
      const ref = prober.client.makeSturdyRef(server.location, missId);
      // eslint-disable-next-line no-await-in-loop
      const error = await t.throwsAsync(() =>
        prober.client.enlivenSturdyRef(ref),
      );
      proberMessages.push(error.message);
    }
    const [firstMiss, secondMiss] = proberMessages;
    t.is(
      secondMiss,
      firstMiss,
      'below-bound misses share one uniform rejection over the wire',
    );

    // Crossing the bound actually severed the transport: the prober's
    // connection is destroyed. The severance propagates across the loopback
    // socket asynchronously (deferred a turn on the far side, then a socket
    // close), so wait for it before asserting.
    await waitFor(() => proberSession.connection.isDestroyed);
    t.true(
      proberSession.connection.isDestroyed,
      'the abusive session was actually severed over the wire, not merely rejected',
    );

    // The holder, a different authenticated peer, fetches its valid guest
    // capability unaffected by the prober crossing its bound. (This also
    // shows the bound is per-connection: the prober could re-dial into a
    // fresh session with its own counter; cross-reconnect aggregation is
    // left to an embedder keying on the session's verified public key.)
    const goodRef = holder.client.makeSturdyRef(server.location, guestId);
    const good = await holder.client.enlivenSturdyRef(goodRef);
    t.is(
      await E(good).greet(),
      'hi',
      'a valid peer is untouched by another peer hitting the bound',
    );

    prober.client.shutdown();
    holder.client.shutdown();
    server.client.shutdown();
  },
);
