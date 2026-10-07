// @ts-nocheck
import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';
import { syrupCodec } from '@endo/ocapn/syrup';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { makeFormulaNonceLocator } from '@endo/daemon/formula-nonce-locator.js';
import { netListenAllowed } from './_net-permission.js';

// This suite is the daemon's first loopback-*listening* test: every case
// binds a TCP netlayer. A sandboxed checkout that forbids `listen(0)`
// should skip rather than fail, so gate on the same probe the rest of the
// daemon suite uses for its listeners.
const netTest = netListenAllowed ? test : test.skip;

const localNode = 'b'.repeat(64);
const agentNode = 'e'.repeat(64);
const formulaNumber = 'a'.repeat(64);
// A real guest identifier carries the guest agent's node number, not the
// daemon's, so the hit cases present one under a registered agent node.
const guestId = `${formulaNumber}:${agentNode}`;
const isLocal = node => node === localNode || node === agentNode;
const foreignId = `${formulaNumber}:${'c'.repeat(64)}`;

const codecs = [
  ['syrup', syrupCodec],
  ['cbor', cborCodec],
];

// Build one OCapN client over the test TCP netlayer. The mechanism is
// transport-agnostic: this exercises the same injected-locator seam that
// a Noise/WebSocket deployment uses, with the codec chosen up front
// (never negotiated on the wire), exactly as the two well-known routes
// choose it.
const makeClient = async ({ codec, designator, locator }) => {
  const netlayerHolder = {};
  const client = await makeOcapn({
    codec,
    debugLabel: designator,
    debugMode: true,
    locator,
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

// Shut both listeners down even when an assertion fails mid-test.
const makePair = async (t, server, client) => {
  const pair = {};
  pair.server = await makeClient(server);
  t.teardown(() => pair.server.client.shutdown());
  pair.client = await makeClient(client);
  t.teardown(() => pair.client.client.shutdown());
  return pair;
};

for (const [codecName, codec] of codecs) {
  netTest(
    `[${codecName}] a local guest formula fetches the guest capability, not host/gateway`,
    async t => {
      const guest = Far('Guest', {
        greet: name => `hello ${name} from the guest`,
      });
      const locator = makeFormulaNonceLocator({
        provideLocalFormula: async id => {
          t.is(
            id,
            guestId,
            'the presented identifier reaches provide verbatim',
          );
          return guest;
        },
        isLocalNode: isLocal,
      });

      const { server, client } = await makePair(
        t,
        { codec, designator: `server-${codecName}`, locator },
        { codec, designator: `client-${codecName}`, locator: new Map() },
      );

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
        isLocalNode: isLocal,
      });
      const { server, client } = await makePair(
        t,
        { codec, designator: `server2-${codecName}`, locator },
        { codec, designator: `client2-${codecName}`, locator: new Map() },
      );

      const missSecrets = [
        'not-a-formula-identifier', // malformed ASCII
        `${formulaNumber.toUpperCase()}:${localNode}`, // noncanonical
        foreignId, // foreign node
        `${'d'.repeat(64)}:${localNode}`, // absent local formula
        `${guestId}\n`, // near miss: trailing newline
        `${guestId}\0`, // near miss: trailing NUL
        ` ${guestId}`, // near miss: leading space
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
        t.false(
          first.includes(secret),
          'the rejection never echoes the presented secret',
        );
      }

      // A valid presentation on the same locator still succeeds, proving
      // the misses were genuine misses and not a dead locator.
      const goodRef = client.client.makeSturdyRef(server.location, guestId);
      const good = await client.client.enlivenSturdyRef(goodRef);
      t.is(await E(good).greet(), 'hi');
    },
  );

  netTest(
    `[${codecName}] completing a session without fetch grants no application capability`,
    async t => {
      const guest = Far('Guest', { greet: () => 'hi' });
      const locator = makeFormulaNonceLocator({
        provideLocalFormula: async () => guest,
        isLocalNode: isLocal,
      });
      const { server, client } = await makePair(
        t,
        { codec, designator: `server3-${codecName}`, locator },
        { codec, designator: `client3-${codecName}`, locator: new Map() },
      );

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
    },
  );
}
