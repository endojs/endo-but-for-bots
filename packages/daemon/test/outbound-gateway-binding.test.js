// @ts-nocheck
// Integration test for the outbound-path gateway binding.
//
// `hello`'s inbound greeter binds the gateway it returns to the authenticated
// peer (see the gateway retention-set tests in endo.test.js). This test covers
// the symmetric *outbound* residual: a peer WE dial must also receive a gateway
// bound to it, never the shared bearer, so it can `followRetentionSet` only for
// its own node — never a third node's, never ours.
//
// It drives the real `tcp-netstring` transport over loopback: one instance
// listens with a capturing greeter, another dials it. The dialer presents the
// gateway threaded down from `makePeer` as the third argument to `connect`. We
// assert on the gateway the listener actually receives through `hello`.

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';

import { make as makeTcpNetstring } from '../src/networks/tcp-netstring.js';

const NODE_A = 'a'.repeat(64); // the dialer (us)
const NODE_B = 'b'.repeat(64); // the peer we dial
const NODE_C = 'c'.repeat(64); // an unrelated third node

// A gateway bound to `boundNode`, mirroring the daemon's `makeGatewayForPeer`:
// `followRetentionSet` answers only for `boundNode` and refuses the gateway's
// own local node. This is the object `makePeer` presents on the outbound path.
const makeBoundGatewayStub = (boundNode, localNode) =>
  Far('Gateway', {
    followRetentionSet: async peerNode => {
      if (peerNode === localNode || peerNode !== boundNode) {
        throw new Error(
          'followRetentionSet is restricted to the authenticated peer node',
        );
      }
      return Far('Reader', {});
    },
  });

// The shared `localGateway`, mirroring the daemon's: it refuses to enumerate
// the local node's index but still answers for a remote node. This is the
// fallback a transport presents when no peer-bound gateway is supplied.
const makeSharedGatewayStub = localNode =>
  Far('Gateway', {
    followRetentionSet: async peerNode => {
      if (peerNode === localNode) {
        throw new Error(
          'followRetentionSet will not enumerate the local node formula index',
        );
      }
      return Far('Reader', {});
    },
  });

// A minimal network-service context. `whenCancelled` is the transport's
// teardown signal; `addDisposalHook` receives the transport's `stopped`
// promise, which rejects on cancellation — the real daemon context awaits and
// catches it, so we do the same here to avoid a spurious unhandled rejection.
const makeFakeContext = cancelled =>
  Far('Context', {
    whenCancelled: () => cancelled,
    cancel: () => {},
    addDisposalHook: hook => {
      Promise.resolve()
        .then(() => hook())
        .catch(() => {});
    },
  });

const makeFakePowers = ({ node, greeter, gateway }) => {
  const store = new Map([['tcp-listen-addr', '127.0.0.1:0']]);
  return Far('NetworkPowers', {
    getPeerInfo: async () => harden({ node }),
    greeter: async () => greeter,
    gateway: async () => gateway,
    lookup: async name => store.get(name),
    storeValue: async (value, name) => {
      store.set(name, value);
    },
  });
};

/**
 * Stand up a listening transport whose greeter captures the gateway an inbound
 * `hello` presents, plus a dialing transport. Returns the dialer's `connect`,
 * the listen address, and a promise for the captured gateway.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {{ dialerGateway: any }} options - `dialerGateway` is what the dialer
 *   transport returns from `E(powers).gateway()` (its shared fallback bearer).
 */
const setupPair = async (t, { dialerGateway }) => {
  const listenerCancelledKit = makePromiseKit();
  const dialerCancelledKit = makePromiseKit();
  listenerCancelledKit.promise.catch(() => {});
  dialerCancelledKit.promise.catch(() => {});

  const capturedGatewayKit = makePromiseKit();
  const capturingGreeter = Far('Greeter', {
    hello: async (_remoteNodeId, remoteGateway, _canceller, connectionCancelled) => {
      // Consume the connection's cancellation signal so tearing the dial down
      // does not surface as an unhandled rejection on this (listener) side.
      Promise.resolve(connectionCancelled).catch(() => {});
      capturedGatewayKit.resolve(remoteGateway);
      return Far('AcknowledgingGateway', {});
    },
  });

  const listener = await makeTcpNetstring(
    makeFakePowers({
      node: NODE_B,
      greeter: capturingGreeter,
      gateway: makeSharedGatewayStub(NODE_B),
    }),
    makeFakeContext(listenerCancelledKit.promise),
  );

  const dialer = await makeTcpNetstring(
    makeFakePowers({
      node: NODE_A,
      greeter: Far('Greeter', { hello: async () => Far('Gateway', {}) }),
      gateway: dialerGateway,
    }),
    makeFakeContext(dialerCancelledKit.promise),
  );

  t.teardown(() => {
    listenerCancelledKit.reject(new Error('teardown'));
    dialerCancelledKit.reject(new Error('teardown'));
  });

  const [address] = listener.addresses();
  t.truthy(address, 'listener advertises a dialable address');

  return { dialer, address, captured: capturedGatewayKit.promise };
};

test.serial(
  'outbound connection presents a gateway bound to the dialed peer',
  async t => {
    t.timeout(20_000);
    // What `makePeer(NODE_B)` builds and threads into `connect`: a gateway
    // bound to the peer we dial.
    const outboundGateway = makeBoundGatewayStub(NODE_B, NODE_A);
    const { dialer, address, captured } = await setupPair(t, {
      dialerGateway: makeSharedGatewayStub(NODE_A),
    });

    const connectionCancelledKit = makePromiseKit();
    connectionCancelledKit.promise.catch(() => {});
    t.teardown(() => connectionCancelledKit.reject(new Error('teardown')));

    await dialer.connect(
      address,
      makeFakeContext(connectionCancelledKit.promise),
      outboundGateway,
    );

    const gateway = await captured;

    // The dialed peer may follow only its own node's retention set.
    t.truthy(
      await E(gateway).followRetentionSet(NODE_B),
      'dialed peer can follow its own retention set',
    );
    // Never a third node's...
    await t.throwsAsync(
      E(gateway).followRetentionSet(NODE_C),
      undefined,
      'dialed peer cannot follow a third node retention set',
    );
    // ...and never ours (the local node).
    await t.throwsAsync(
      E(gateway).followRetentionSet(NODE_A),
      undefined,
      'dialed peer cannot follow the local node retention set',
    );
  },
);

test.serial(
  'outbound connection falls back to the shared gateway when unbound',
  async t => {
    t.timeout(20_000);
    const { dialer, address, captured } = await setupPair(t, {
      dialerGateway: makeSharedGatewayStub(NODE_A),
    });

    const connectionCancelledKit = makePromiseKit();
    connectionCancelledKit.promise.catch(() => {});
    t.teardown(() => connectionCancelledKit.reject(new Error('teardown')));

    // No peer-bound gateway argument: the transport presents the shared
    // localGateway, which still refuses to enumerate the local node's index.
    await dialer.connect(
      address,
      makeFakeContext(connectionCancelledKit.promise),
    );

    const gateway = await captured;

    await t.throwsAsync(
      E(gateway).followRetentionSet(NODE_A),
      undefined,
      'shared gateway will not enumerate the local node index',
    );
    t.truthy(
      await E(gateway).followRetentionSet(NODE_C),
      'shared gateway still answers for a remote node',
    );
  },
);
