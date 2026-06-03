// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { E, Far } from '@endo/far';
import { makePipe } from '@endo/stream';

import {
  isOcapnWebSocketPath,
  makeGateway,
  makeGatewayBootstrap,
  makeAppsNameHub,
  makeOcapnWebSocketHandler,
  OCAPN_INTENDED_RESPONDER_PREFIX_LENGTH,
  OCAPN_WEBSOCKET_LEGACY_PATH,
  OCAPN_WEBSOCKET_PATH,
} from '../index.js';

import {
  makeNodeCryptoPowers,
  generateNodeEd25519Keypair,
} from '../src/node-crypto-powers.js';

/**
 * @param {number} initial
 */
const makeFakeClock = (initial = 0) => {
  let now = initial;
  return harden({
    now: () => now,
    advance: ms => {
      now += ms;
    },
  });
};

/**
 * Stand up a bootstrap + a fresh OCapN handler that reads from its
 * registration table. Used by tests that need the real lookup path.
 */
const stand = () => {
  const apps = makeAppsNameHub();
  const handle = makeGatewayBootstrap({
    crypto: makeNodeCryptoPowers(),
    clock: makeFakeClock(),
    apps,
    getBindAddress: () => '0.0.0.0:3469',
  });
  const handler = makeOcapnWebSocketHandler({
    lookupRegistrationByPublicKey: handle.lookupRegistrationByPublicKey,
  });
  return { apps, handle, handler };
};

/**
 * Register `publicKey` with the given `daemon` exo. Runs the full
 * challenge / sign / register flow.
 *
 * @param {ReturnType<typeof makeGatewayBootstrap>} handle
 * @param {{ publicKey: Uint8Array, privateKey: Uint8Array, sign: (m: Uint8Array) => Uint8Array }} keypair
 * @param {unknown} daemon
 */
const registerDaemon = async (handle, keypair, daemon) => {
  const challenge = await E(handle.bootstrap).challenge();
  return E(handle.bootstrap).register(
    harden({
      publicKey: keypair.publicKey,
      nonce: challenge.nonce,
      signature: keypair.sign(challenge.hashedNonce),
      daemon,
    }),
  );
};

/**
 * Coerce any byte-shaped input to a `Uint8Array` view. Handles both
 * mutable `ArrayBuffer` and the immutable `ArrayBuffer` shape the
 * gateway's crypto adapter returns; the latter cannot back a typed
 * array directly, so we copy.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
const asView = bytes => bytes;

/**
 * Wrap a raw `@endo/stream` endpoint as a `Far`-tagged remotable so
 * the exo's `M.any()` argument guard admits it. Real WS-upgrade
 * adapters build Far-tagged readers/writers directly; for tests we
 * wrap the `makePipe()` pair after the fact.
 *
 * @template T
 * @param {string} label
 * @param {T} stream
 * @returns {T}
 */
const farStream = (label, stream) => {
  const s = /** @type {any} */ (stream);
  return /** @type {T} */ (
    Far(label, {
      next: arg => s.next(arg),
      return: arg => s.return(arg),
      throw: arg => s.throw(arg),
    })
  );
};

/**
 * Build a Uint8Array suitable as a "prefixed SYN" first frame:
 * 32 bytes of intended-responder public key followed by a 132-byte
 * filler. The filler is opaque to the gateway (it forwards the
 * frame to the daemon without inspection).
 *
 * @param {Uint8Array} publicKey 32-byte intended-responder key.
 * @param {number} [tailLength] defaults to 132 (the OCapN-Noise
 *   SYN_LENGTH); pass a smaller value to exercise the
 *   short-frame-reject branch.
 */
const synFrame = (publicKey, tailLength = 132) => {
  const view = asView(publicKey);
  const frame = new Uint8Array(view.length + tailLength);
  frame.set(view, 0);
  for (let i = 0; i < tailLength; i += 1) {
    // Modulo-by-256 keeps each byte within a Uint8Array's range;
    // the value is opaque to the gateway (it just forwards bytes).
    frame[view.length + i] = (i + 1) % 256;
  }
  return frame;
};

// -- Path matcher --------------------------------------------------

test('isOcapnWebSocketPath recognizes canonical and legacy paths', t => {
  t.true(isOcapnWebSocketPath(OCAPN_WEBSOCKET_PATH));
  t.true(isOcapnWebSocketPath(OCAPN_WEBSOCKET_LEGACY_PATH));
  t.true(isOcapnWebSocketPath('/ocapn-cbor-np'));
  t.true(isOcapnWebSocketPath('/ocapn'));
  t.false(isOcapnWebSocketPath('/ocapn-cbor-tls'));
  t.false(isOcapnWebSocketPath('/ocapn-syrups-tcp'));
  t.false(isOcapnWebSocketPath('/something-else'));
  t.false(isOcapnWebSocketPath('/ocapn-cbor-np/'));
  t.false(isOcapnWebSocketPath('/OCAPN-CBOR-NP'));
  t.false(isOcapnWebSocketPath(/** @type {any} */ (undefined)));
});

// -- Factory shape -------------------------------------------------

test('makeOcapnWebSocketHandler requires a lookup function', t => {
  t.throws(() => makeOcapnWebSocketHandler(/** @type {any} */ ({})), {
    message: /requires a lookupRegistrationByPublicKey function/,
  });
});

test('handleConnection rejects non-object stream input', async t => {
  const { handler } = stand();
  await t.throwsAsync(E(handler).handleConnection(/** @type {any} */ (null)), {
    message: /expects a \{ reader, writer \}/,
  });
});

test('handleConnection rejects malformed reader / writer', async t => {
  const { handler } = stand();
  // The reader and writer must be `Far`-tagged stream-shaped
  // remotables. A plain object with a `next` function fails the
  // exo's argument-passability check (and is rejected before the
  // handler runs), exactly as we want: a non-Far reader could not
  // cross a CapTP boundary either.
  await t.throwsAsync(
    E(handler).handleConnection(
      /** @type {any} */ (
        harden({
          reader: Far('NotAReader', {}),
          writer: Far('Writer', { next: async () => {} }),
        })
      ),
    ),
    { message: /stream.reader is not a Reader/ },
  );
  await t.throwsAsync(
    E(handler).handleConnection(
      /** @type {any} */ (
        harden({
          reader: Far('Reader', { next: async () => {} }),
          writer: Far('NotAWriter', {}),
        })
      ),
    ),
    { message: /stream.writer is not a Writer/ },
  );
});

// -- Routing semantics: positive path -----------------------------

test('handleConnection forwards to the registration that owns the intended responder', async t => {
  const { handle, handler } = stand();
  const keypair = await generateNodeEd25519Keypair();

  /** @type {{ reader?: unknown, writer?: unknown }} */
  const observed = {};
  const daemon = Far('UserDaemon', {
    /** @param {{ reader: unknown, writer: unknown }} target */
    async handleOcapnSession(target) {
      observed.reader = target.reader;
      observed.writer = target.writer;
    },
  });
  await registerDaemon(handle, keypair, daemon);

  // Peer-to-gateway pipe: the peer writes frames, the gateway reads
  // them. Gateway-to-peer pipe: the gateway writes frames, the peer
  // reads them.
  const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
  const [gwWriterRaw, _peerFromGw] = /** @type {[any, any]} */ (makePipe());
  const peerToGw = peerToGwRaw;
  const gwReader = farStream('GwReader', gwReaderRaw);
  const gwWriter = farStream('GwWriter', gwWriterRaw);

  const handled = E(handler).handleConnection(
    /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
  );

  // Send the prefixed SYN.
  const syn = synFrame(keypair.publicKey);
  await peerToGw.next(syn);

  await handled;

  // The daemon received the stream pair.
  t.truthy(observed.reader);
  t.truthy(observed.writer);

  // The daemon's reader replays the first frame (prefix + SYN), so
  // the daemon's Noise responder sees the unmodified bytes.
  const r = /** @type {any} */ (observed.reader);
  const first = await E(r).next();
  t.false(first.done);
  t.deepEqual(first.value, syn);

  // Subsequent frames flow through unchanged. We push the second
  // frame fire-and-forget because peerToGw's `next` only resolves
  // when the gateway-side reader acks (which our `E(r).next()`
  // arranges); awaiting both serially deadlocks.
  const next = new Uint8Array([1, 2, 3, 4]);
  void peerToGw.next(next);
  const second = await E(r).next();
  t.false(second.done);
  t.deepEqual(second.value, next);
});

test('handleConnection prefers daemon over relayTarget when both are set', async t => {
  // The bootstrap shape requires daemon XOR relayTarget per
  // register / registerRelay. We still cover the precedence
  // explicitly so a future refactor that admits both does not
  // accidentally invert the priority.
  const apps = makeAppsNameHub();
  const calls = { daemon: 0, relay: 0 };
  const daemon = Far('UserDaemon', {
    async handleOcapnSession(_target) {
      calls.daemon += 1;
    },
  });
  const relayTarget = Far('RelayTarget', {
    async handleOcapnSession(_target) {
      calls.relay += 1;
    },
  });
  const lookupRegistrationByPublicKey = _publicKey =>
    harden({ daemon, relayTarget });
  const handler = makeOcapnWebSocketHandler({ lookupRegistrationByPublicKey });
  void apps;

  const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
  const [gwWriterRaw, _peerFromGw] = /** @type {[any, any]} */ (makePipe());
  const peerToGw = peerToGwRaw;
  const gwReader = farStream('GwReader', gwReaderRaw);
  const gwWriter = farStream('GwWriter', gwWriterRaw);
  const handled = E(handler).handleConnection(
    /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
  );
  const dummyKey = new Uint8Array(OCAPN_INTENDED_RESPONDER_PREFIX_LENGTH).fill(
    7,
  );
  await peerToGw.next(synFrame(dummyKey));
  await handled;

  t.is(calls.daemon, 1);
  t.is(calls.relay, 0);
});

// -- Routing semantics: negative paths ----------------------------

test('handleConnection closes on no-registration for the intended responder', async t => {
  const { handler } = stand();

  const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
  const [gwWriterRaw, peerFromGw] = /** @type {[any, any]} */ (makePipe());
  const peerToGw = peerToGwRaw;
  const gwReader = farStream('GwReader', gwReaderRaw);
  const gwWriter = farStream('GwWriter', gwWriterRaw);

  const handled = E(handler).handleConnection(
    /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
  );

  // Send a SYN whose intended-responder key is not registered.
  const unknownKey = new Uint8Array(
    OCAPN_INTENDED_RESPONDER_PREFIX_LENGTH,
  ).fill(0x42);
  await peerToGw.next(synFrame(unknownKey));

  await handled;

  // The gateway closed both halves.
  const fromGw = await peerFromGw.next();
  t.true(fromGw.done);
});

test('handleConnection closes on short first frame', async t => {
  // Register a daemon whose public key matches the leading bytes
  // of the truncated frame the test sends. That isolates the
  // short-frame check: a buggy handler that skipped the length
  // check would proceed to look up the prefix (matching this
  // registration), call into the daemon, and the test would
  // observe a non-closed reply. With the length check intact, the
  // handler closes before lookup.
  const { handle, handler } = stand();
  const keypair = await generateNodeEd25519Keypair();
  const calls = { count: 0 };
  await registerDaemon(
    handle,
    keypair,
    Far('UserDaemon', {
      async handleOcapnSession() {
        calls.count += 1;
      },
    }),
  );

  const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
  const [gwWriterRaw, peerFromGw] = /** @type {[any, any]} */ (makePipe());
  const peerToGw = peerToGwRaw;
  const gwReader = farStream('GwReader', gwReaderRaw);
  const gwWriter = farStream('GwWriter', gwWriterRaw);
  const handled = E(handler).handleConnection(
    /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
  );

  // A frame shorter than 164 bytes is not a valid prefixed SYN.
  // The 32 bytes happen to match a registered key; this isolates
  // the length-check branch from the lookup branch.
  await peerToGw.next(asView(keypair.publicKey));
  await handled;

  const fromGw = await peerFromGw.next();
  t.true(fromGw.done);
  // The daemon must not have been invoked.
  t.is(calls.count, 0);
});

test('handleConnection closes when peer hangs up before the first frame', async t => {
  const { handler } = stand();

  const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
  const [gwWriterRaw, peerFromGw] = /** @type {[any, any]} */ (makePipe());
  const peerToGw = peerToGwRaw;
  const gwReader = farStream('GwReader', gwReaderRaw);
  const gwWriter = farStream('GwWriter', gwWriterRaw);

  const handled = E(handler).handleConnection(
    /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
  );
  await peerToGw.return(undefined);

  await handled;
  const fromGw = await peerFromGw.next();
  t.true(fromGw.done);
});

test('handleConnection closes when the registered daemon throws', async t => {
  const { handle, handler } = stand();
  const keypair = await generateNodeEd25519Keypair();
  await registerDaemon(
    handle,
    keypair,
    Far('UserDaemon', {
      async handleOcapnSession() {
        throw Error('daemon disposed');
      },
    }),
  );

  const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
  const [gwWriterRaw, peerFromGw] = /** @type {[any, any]} */ (makePipe());
  const peerToGw = peerToGwRaw;
  const gwReader = farStream('GwReader', gwReaderRaw);
  const gwWriter = farStream('GwWriter', gwWriterRaw);

  const handled = E(handler).handleConnection(
    /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
  );
  await peerToGw.next(synFrame(keypair.publicKey));
  await handled;

  const fromGw = await peerFromGw.next();
  t.true(fromGw.done);
});

test('handleConnection closes when registration has neither daemon nor relayTarget', async t => {
  // The bootstrap never builds such a registration; this guards
  // the defensive branch against a future refactor that loosens
  // bootstrap's invariant.
  const lookupRegistrationByPublicKey = _publicKey => harden({});
  const handler = makeOcapnWebSocketHandler({ lookupRegistrationByPublicKey });

  const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
  const [gwWriterRaw, peerFromGw] = /** @type {[any, any]} */ (makePipe());
  const peerToGw = peerToGwRaw;
  const gwReader = farStream('GwReader', gwReaderRaw);
  const gwWriter = farStream('GwWriter', gwWriterRaw);
  const handled = E(handler).handleConnection(
    /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
  );
  const k = new Uint8Array(OCAPN_INTENDED_RESPONDER_PREFIX_LENGTH).fill(9);
  await peerToGw.next(synFrame(k));
  await handled;

  const fromGw = await peerFromGw.next();
  t.true(fromGw.done);
});

// -- Bidirectional pumping ----------------------------------------

test('writer hands through unchanged so the daemon can reply on the same socket', async t => {
  const { handle, handler } = stand();
  const keypair = await generateNodeEd25519Keypair();

  /** @type {any} */
  let receivedTarget;
  const daemon = Far('UserDaemon', {
    /** @param {{ reader: any, writer: any }} target */
    async handleOcapnSession(target) {
      receivedTarget = target;
    },
  });
  await registerDaemon(handle, keypair, daemon);

  const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
  const [gwWriterRaw, peerFromGw] = /** @type {[any, any]} */ (makePipe());
  const peerToGw = peerToGwRaw;
  const gwReader = farStream('GwReader', gwReaderRaw);
  const gwWriter = farStream('GwWriter', gwWriterRaw);
  const handled = E(handler).handleConnection(
    /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
  );
  await peerToGw.next(synFrame(keypair.publicKey));
  await handled;

  // The daemon writes via the handed-off writer; the peer reads
  // the bytes verbatim. This is the gateway's "pumps frames in
  // both directions without inspecting them" contract.
  const reply = new Uint8Array([10, 20, 30, 40]);
  void receivedTarget.writer.next(reply);
  const got = await peerFromGw.next();
  t.false(got.done);
  t.deepEqual(got.value, reply);
});

// -- Gateway integration ------------------------------------------

test('makeGateway exposes the OCapN handler via getOcapnHandler', async t => {
  const gateway = makeGateway({
    powers: harden({
      crypto: makeNodeCryptoPowers(),
      clock: makeFakeClock(),
    }),
  });
  const ocapn = await E(gateway).getOcapnHandler();
  t.truthy(ocapn);
  // CapTP introspection: the exo carries `__getMethodNames__`
  // automatically via `makeExo`. We dot-access via a `as any` cast
  // so eslint's `no-underscore-dangle` rule (legitimately concerned
  // about ad-hoc privates) is not triggered on this conventional
  // CapTP introspection helper.
  const introspect = /** @type {any} */ (ocapn);
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(introspect).__getMethodNames__();
  t.true(methods.includes('handleConnection'));
});

test('getOcapnHandler throws when the feature toggle is off', async t => {
  const gateway = makeGateway({
    powers: harden({
      crypto: makeNodeCryptoPowers(),
      clock: makeFakeClock(),
    }),
    config: harden({
      enableFeatures: harden({
        chatHosting: false,
        virtualHosting: true,
        gitHttp: true,
        sockBootstrap: true,
        captpRelay: false,
        adminDaemon: true,
        ocapnWebSocket: false,
      }),
    }),
  });
  await t.throwsAsync(E(gateway).getOcapnHandler(), {
    message: /OCapN WebSocket handler is disabled/,
  });
});

test('mergeGatewayConfig rejects ocapnWebSocket without sockBootstrap', t => {
  t.throws(
    () =>
      makeGateway({
        powers: harden({
          crypto: makeNodeCryptoPowers(),
          clock: makeFakeClock(),
        }),
        config: harden({
          enableFeatures: harden({
            chatHosting: false,
            virtualHosting: true,
            gitHttp: true,
            sockBootstrap: false,
            captpRelay: false,
            adminDaemon: false,
            ocapnWebSocket: true,
          }),
        }),
      }),
    { message: /ocapnWebSocket depends on sockBootstrap/ },
  );
});

// -- Bootstrap backplane: lookupRegistrationByPublicKey -----------

test('lookupRegistrationByPublicKey returns undefined for unknown keys', t => {
  const { handle } = stand();
  const unknown = new Uint8Array(32).fill(0xaa);
  t.is(handle.lookupRegistrationByPublicKey(unknown), undefined);
});

test('lookupRegistrationByPublicKey returns daemon after register', async t => {
  const { handle } = stand();
  const keypair = await generateNodeEd25519Keypair();
  const daemon = Far('UserDaemon', {
    async handleOcapnSession() {
      /* placeholder daemon */
    },
  });
  await registerDaemon(handle, keypair, daemon);
  const result = handle.lookupRegistrationByPublicKey(keypair.publicKey);
  t.truthy(result);
  t.is(result?.daemon, daemon);
  t.is(result?.relayTarget, undefined);
});

test('lookupRegistrationByPublicKey returns undefined after deregister', async t => {
  const { handle } = stand();
  const keypair = await generateNodeEd25519Keypair();
  const daemon = Far('UserDaemon', {
    async handleOcapnSession() {
      /* placeholder daemon */
    },
  });
  await registerDaemon(handle, keypair, daemon);
  handle.deregisterByPublicKey(keypair.publicKey);
  t.is(handle.lookupRegistrationByPublicKey(keypair.publicKey), undefined);
});

// -- Relay-policy admission (Phase 5 / Feature 6) -----------------

/**
 * Register a relay target via `registerRelay`. Returns the
 * registration handle so the test can mutate the policy through it.
 *
 * @param {ReturnType<typeof makeGatewayBootstrap>} handle
 * @param {{ publicKey: Uint8Array, privateKey: Uint8Array, sign: (m: Uint8Array) => Uint8Array }} keypair
 * @param {unknown} relayTarget
 * @param {'closed' | 'open'} [relayPolicy]
 */
const registerRelayTarget = async (
  handle,
  keypair,
  relayTarget,
  relayPolicy,
) => {
  const challenge = await E(handle.bootstrap).challenge();
  const args = harden({
    publicKey: keypair.publicKey,
    nonce: challenge.nonce,
    signature: keypair.sign(challenge.hashedNonce),
    relayTarget,
    ...(relayPolicy === undefined ? {} : { relayPolicy }),
  });
  return E(handle.bootstrap).registerRelay(args);
};

test('handleConnection drops a closed-policy relay session when no dialer extractor is wired', async t => {
  // Regression: today's Noise IK wire shape encrypts the dialer's
  // static; the gateway cannot identify the caller. The handler
  // must fail closed rather than silently relay; a refactor that
  // defaulted to allow would put the gateway in a default-open
  // relay shape.
  const { handle, handler } = stand();
  const keypair = await generateNodeEd25519Keypair();
  const calls = { count: 0 };
  await registerRelayTarget(
    handle,
    keypair,
    Far('RelayTarget', {
      async handleOcapnSession() {
        calls.count += 1;
      },
    }),
  );

  const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
  const [gwWriterRaw, peerFromGw] = /** @type {[any, any]} */ (makePipe());
  const peerToGw = peerToGwRaw;
  const gwReader = farStream('GwReader', gwReaderRaw);
  const gwWriter = farStream('GwWriter', gwWriterRaw);
  const handled = E(handler).handleConnection(
    /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
  );
  await peerToGw.next(synFrame(keypair.publicKey));
  await handled;

  // Relay target was not invoked; stream closed.
  t.is(calls.count, 0);
  const fromGw = await peerFromGw.next();
  t.true(fromGw.done);
});

test('handleConnection forwards an open-policy relay session regardless of dialer', async t => {
  const { handle, handler } = stand();
  const keypair = await generateNodeEd25519Keypair();
  const calls = { count: 0 };
  await registerRelayTarget(
    handle,
    keypair,
    Far('RelayTarget', {
      async handleOcapnSession() {
        calls.count += 1;
      },
    }),
    'open',
  );

  const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
  const [gwWriterRaw, _peerFromGw] = /** @type {[any, any]} */ (makePipe());
  const peerToGw = peerToGwRaw;
  const gwReader = farStream('GwReader', gwReaderRaw);
  const gwWriter = farStream('GwWriter', gwWriterRaw);
  const handled = E(handler).handleConnection(
    /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
  );
  await peerToGw.next(synFrame(keypair.publicKey));
  await handled;

  t.is(calls.count, 1);
});

test('handleConnection forwards a closed-policy session when the dialer is allowlisted', async t => {
  // Stand the handler with a test extractor that reads the dialer
  // key out of the "second 32-byte slot" the dispatch prompt
  // describes. Under today's Noise IK this slot is encrypted (so
  // the production handler would not have an extractor); we model
  // the future-extension case so the allowlist semantics have
  // a working test.
  const apps = makeAppsNameHub();
  const handle = makeGatewayBootstrap({
    crypto: makeNodeCryptoPowers(),
    clock: makeFakeClock(),
    apps,
    getBindAddress: () => '0.0.0.0:3469',
  });
  /** @param {Uint8Array} firstFrame */
  const extractDialerPublicKey = firstFrame => firstFrame.slice(32, 64);
  const handler = makeOcapnWebSocketHandler({
    lookupRegistrationByPublicKey: handle.lookupRegistrationByPublicKey,
    extractDialerPublicKey,
  });

  const keypair = await generateNodeEd25519Keypair();
  const calls = { count: 0 };
  const r = await registerRelayTarget(
    handle,
    keypair,
    Far('RelayTarget', {
      async handleOcapnSession() {
        calls.count += 1;
      },
    }),
  );
  // Allowlist a fixed dialer key, then dial with the matching key.
  const dialerKey = new Uint8Array(32).fill(0x55);
  await E(r).addCallerPublicKey(dialerKey);

  const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
  const [gwWriterRaw, _peerFromGw] = /** @type {[any, any]} */ (makePipe());
  const peerToGw = peerToGwRaw;
  const gwReader = farStream('GwReader', gwReaderRaw);
  const gwWriter = farStream('GwWriter', gwWriterRaw);
  const handled = E(handler).handleConnection(
    /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
  );
  // Build a frame whose second 32 bytes match the allowlisted key.
  const frame = synFrame(keypair.publicKey);
  frame.set(dialerKey, 32);
  await peerToGw.next(frame);
  await handled;

  t.is(calls.count, 1);
});

test('handleConnection drops a closed-policy session when the dialer is not allowlisted', async t => {
  const apps = makeAppsNameHub();
  const handle = makeGatewayBootstrap({
    crypto: makeNodeCryptoPowers(),
    clock: makeFakeClock(),
    apps,
    getBindAddress: () => '0.0.0.0:3469',
  });
  /** @param {Uint8Array} firstFrame */
  const extractDialerPublicKey = firstFrame => firstFrame.slice(32, 64);
  const handler = makeOcapnWebSocketHandler({
    lookupRegistrationByPublicKey: handle.lookupRegistrationByPublicKey,
    extractDialerPublicKey,
  });

  const keypair = await generateNodeEd25519Keypair();
  const calls = { count: 0 };
  const r = await registerRelayTarget(
    handle,
    keypair,
    Far('RelayTarget', {
      async handleOcapnSession() {
        calls.count += 1;
      },
    }),
  );
  // Allowlist a key the dialer will NOT match.
  await E(r).addCallerPublicKey(new Uint8Array(32).fill(0x55));

  const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
  const [gwWriterRaw, peerFromGw] = /** @type {[any, any]} */ (makePipe());
  const peerToGw = peerToGwRaw;
  const gwReader = farStream('GwReader', gwReaderRaw);
  const gwWriter = farStream('GwWriter', gwWriterRaw);
  const handled = E(handler).handleConnection(
    /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
  );
  // The frame's "second slot" is a 0x99 fill (synFrame's filler
  // happens to start at 1; for clarity we set explicitly).
  const frame = synFrame(keypair.publicKey);
  frame.set(new Uint8Array(32).fill(0x99), 32);
  await peerToGw.next(frame);
  await handled;

  t.is(calls.count, 0);
  const fromGw = await peerFromGw.next();
  t.true(fromGw.done);
});

test('handleConnection ignores relayPolicy on a register (non-relay) entry', async t => {
  // Regression: a `register` (daemon) entry has no policy. The
  // handler must forward unconditionally; a refactor that
  // accidentally checked policy=closed across the daemon case
  // would silently drop user-daemon sessions.
  const { handle, handler } = stand();
  const keypair = await generateNodeEd25519Keypair();
  const calls = { count: 0 };
  await registerDaemon(
    handle,
    keypair,
    Far('UserDaemon', {
      async handleOcapnSession() {
        calls.count += 1;
      },
    }),
  );

  const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
  const [gwWriterRaw, _peerFromGw] = /** @type {[any, any]} */ (makePipe());
  const peerToGw = peerToGwRaw;
  const gwReader = farStream('GwReader', gwReaderRaw);
  const gwWriter = farStream('GwWriter', gwWriterRaw);
  const handled = E(handler).handleConnection(
    /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
  );
  await peerToGw.next(synFrame(keypair.publicKey));
  await handled;

  t.is(calls.count, 1);
});

test('handleConnection drops a session when extractDialerPublicKey throws', async t => {
  // Regression: a faulty adapter should not crash the handler. The
  // close path mirrors the daemon-throws branch.
  const apps = makeAppsNameHub();
  const handle = makeGatewayBootstrap({
    crypto: makeNodeCryptoPowers(),
    clock: makeFakeClock(),
    apps,
    getBindAddress: () => '0.0.0.0:3469',
  });
  const extractDialerPublicKey = () => {
    throw Error('adapter blew up');
  };
  const handler = makeOcapnWebSocketHandler({
    lookupRegistrationByPublicKey: handle.lookupRegistrationByPublicKey,
    extractDialerPublicKey,
  });

  const keypair = await generateNodeEd25519Keypair();
  const calls = { count: 0 };
  await registerRelayTarget(
    handle,
    keypair,
    Far('RelayTarget', {
      async handleOcapnSession() {
        calls.count += 1;
      },
    }),
  );

  const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
  const [gwWriterRaw, peerFromGw] = /** @type {[any, any]} */ (makePipe());
  const peerToGw = peerToGwRaw;
  const gwReader = farStream('GwReader', gwReaderRaw);
  const gwWriter = farStream('GwWriter', gwWriterRaw);
  const handled = E(handler).handleConnection(
    /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
  );
  await peerToGw.next(synFrame(keypair.publicKey));
  await handled;

  t.is(calls.count, 0);
  const fromGw = await peerFromGw.next();
  t.true(fromGw.done);
});

test('makeOcapnWebSocketHandler rejects a non-function extractDialerPublicKey', t => {
  t.throws(
    () =>
      makeOcapnWebSocketHandler(
        /** @type {any} */ ({
          lookupRegistrationByPublicKey: () => undefined,
          extractDialerPublicKey: 'not-a-function',
        }),
      ),
    { message: /must be a function/ },
  );
});

test('handleConnection picks up a live allowlist mutation between sessions', async t => {
  // Regression: the policy admission must read through the live
  // policy entry. A previous design that snapshotted at lookup
  // time would have a stale allowlist if the registrant added the
  // dialer key between sessions.
  const apps = makeAppsNameHub();
  const handle = makeGatewayBootstrap({
    crypto: makeNodeCryptoPowers(),
    clock: makeFakeClock(),
    apps,
    getBindAddress: () => '0.0.0.0:3469',
  });
  /** @param {Uint8Array} firstFrame */
  const extractDialerPublicKey = firstFrame => firstFrame.slice(32, 64);
  const handler = makeOcapnWebSocketHandler({
    lookupRegistrationByPublicKey: handle.lookupRegistrationByPublicKey,
    extractDialerPublicKey,
  });

  const keypair = await generateNodeEd25519Keypair();
  const calls = { count: 0 };
  const r = await registerRelayTarget(
    handle,
    keypair,
    Far('RelayTarget', {
      async handleOcapnSession() {
        calls.count += 1;
      },
    }),
  );

  const dialerKey = new Uint8Array(32).fill(0x77);
  // First session: dialer not yet allowlisted -> dropped.
  {
    const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
    const [gwWriterRaw, _peerFromGw] = /** @type {[any, any]} */ (makePipe());
    const peerToGw = peerToGwRaw;
    const gwReader = farStream('GwReader', gwReaderRaw);
    const gwWriter = farStream('GwWriter', gwWriterRaw);
    const handled = E(handler).handleConnection(
      /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
    );
    const frame = synFrame(keypair.publicKey);
    frame.set(dialerKey, 32);
    await peerToGw.next(frame);
    await handled;
  }
  t.is(calls.count, 0);

  // Admin / registrant adds the dialer to the allowlist.
  await E(r).addCallerPublicKey(dialerKey);

  // Second session with the same dialer is now admitted.
  {
    const [peerToGwRaw, gwReaderRaw] = /** @type {[any, any]} */ (makePipe());
    const [gwWriterRaw, _peerFromGw] = /** @type {[any, any]} */ (makePipe());
    const peerToGw = peerToGwRaw;
    const gwReader = farStream('GwReader', gwReaderRaw);
    const gwWriter = farStream('GwWriter', gwWriterRaw);
    const handled = E(handler).handleConnection(
      /** @type {any} */ (harden({ reader: gwReader, writer: gwWriter })),
    );
    const frame = synFrame(keypair.publicKey);
    frame.set(dialerKey, 32);
    await peerToGw.next(frame);
    await handled;
  }
  t.is(calls.count, 1);
});
