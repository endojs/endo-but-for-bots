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

const localNode = 'b'.repeat(64);
const formulaNumber = 'a'.repeat(64);
const guestId = `${formulaNumber}:${localNode}`;
const foreignId = `${formulaNumber}:${'c'.repeat(64)}`;

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
  const ref = {};
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
        ref.netlayer = netlayer;
        return netlayer;
      }),
  });
  return { client, location: ref.netlayer.location };
};

for (const [codecName, codec] of codecs) {
  test(`[${codecName}] a local guest formula fetches the guest capability, not host/gateway`, async t => {
    const guest = Far('Guest', {
      greet: name => `hello ${name} from the guest`,
    });
    const endpoint = makeFormulaNonceLocator({
      provideLocalFormula: async (id, node) => {
        t.is(id, guestId, 'the presented identifier reaches provide verbatim');
        t.is(node, localNode);
        return guest;
      },
      localNodeNumber: localNode,
    });

    const server = await makeClient({
      codec,
      designator: `server-${codecName}`,
      makeLocatorForSession: endpoint.makeLocatorForSession,
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
  });

  test(`[${codecName}] every miss class produces the same peer-visible rejection`, async t => {
    // The endpoint provides only the one guest; every other presentation
    // must be an indistinguishable miss.
    const guest = Far('Guest', { greet: () => 'hi' });
    const endpoint = makeFormulaNonceLocator({
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
      makeLocatorForSession: endpoint.makeLocatorForSession,
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
      'endo-bootstrap', // old fixed name
      'endo-peer-entry', // old fixed name
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

    // A valid presentation on the same endpoint still succeeds, proving
    // the misses were genuine misses and not a dead endpoint.
    const goodRef = client.client.makeSturdyRef(server.location, guestId);
    const good = await client.client.enlivenSturdyRef(goodRef);
    t.is(await E(good).greet(), 'hi');

    client.client.shutdown();
    server.client.shutdown();
  });

  test(`[${codecName}] completing a session without fetch grants no application capability`, async t => {
    const guest = Far('Guest', { greet: () => 'hi' });
    const endpoint = makeFormulaNonceLocator({
      provideLocalFormula: async () => guest,
      localNodeNumber: localNode,
    });
    const server = await makeClient({
      codec,
      designator: `server3-${codecName}`,
      makeLocatorForSession: endpoint.makeLocatorForSession,
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
  });
}

test('the per-session miss bound aborts the abusive session but not a valid peer, over the wire', async t => {
  const guest = Far('Guest', { greet: () => 'hi' });
  const endpoint = makeFormulaNonceLocator({
    provideLocalFormula: async id => {
      if (id === guestId) return guest;
      throw new ReferenceError('absent');
    },
    localNodeNumber: localNode,
    missBound: 3,
  });
  // Wrap the endpoint's session factory to observe that crossing the
  // bound actually reaches the session-teardown callback over the wire
  // (the callback the ocapn client binds to a real connection-severing
  // abort, not a bookkeeping-only deregister). A mere "each fetch throws"
  // assertion cannot tell a torn-down session from one that kept
  // answering, so we count the aborts the transport path triggers.
  let wireAborts = 0;
  const observedMakeLocatorForSession = context =>
    endpoint.makeLocatorForSession({
      ...context,
      abortSession: () => {
        wireAborts += 1;
        context.abortSession();
      },
    });
  const server = await makeClient({
    codec: syrupCodec,
    designator: 'server-bound',
    makeLocatorForSession: observedMakeLocatorForSession,
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

  // The prober misses repeatedly; each below-bound miss is the same
  // rejection, and crossing the bound aborts its session. Collect the
  // peer-visible messages so we can observe the crossing directly: every
  // presentation *below* the bound (probes 1..missBound-1) must be the
  // identical uniform miss over the wire, and crossing the bound must
  // sever the session (asserted via `wireAborts` below). The security
  // property is uniformity of the below-bound misses plus severance at
  // the crossing — not that the crossing reply is byte-identical, which
  // would rest on engine-dependent teardown ordering.
  const proberMessages = [];
  for (let i = 0; i < 4; i += 1) {
    const ref = prober.client.makeSturdyRef(
      server.location,
      `${'e'.repeat(64)}:${localNode}`,
    );
    // eslint-disable-next-line no-await-in-loop
    const error = await t.throwsAsync(() =>
      prober.client.enlivenSturdyRef(ref),
    );
    proberMessages.push(error.message);
  }

  // Probes 1 and 2 are below the bound (missBound is 3): they share one
  // uniform message, so no below-bound miss is an oracle over the wire.
  const [firstMiss, secondMiss] = proberMessages;
  t.is(
    secondMiss,
    firstMiss,
    'below-bound misses share one uniform rejection over the wire',
  );

  // Crossing the bound reached the real session-teardown callback over
  // the wire — the abuse is actually severed, not merely rejected each
  // time. (The bound is per-connection: a fresh dial re-handshakes into a
  // new session with its own counter, which is why the prober's 4th probe
  // still throws rather than the process wedging — cross-reconnect
  // aggregation is left to an embedder keying on `remoteDesignator`.)
  t.true(
    wireAborts >= 1,
    'the abusive session was torn down over the wire, not just rejected',
  );

  // The holder, a different authenticated peer, fetches its valid guest
  // capability unaffected by the prober crossing its bound.
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
});
