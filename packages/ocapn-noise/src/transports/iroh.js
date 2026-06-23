// @ts-check

/**
 * Iroh QUIC byte-stream transport.
 *
 * Same `OcapnNoiseTransport` shape as `tcp.js`, but the wire is an Iroh
 * QUIC bidirectional stream instead of a TCP socket. The defining
 * difference: there is **no advertised `host:port`**. A peer is dialed by
 * its **EndpointId** — a base32 Ed25519 public key — over an authenticated
 * QUIC handshake (TLS 1.3, RFC 7250 raw public keys). Nothing on the LAN
 * listens on a guessable port, so a confined worker has no `localhost:PORT`
 * surface to scan or stumble onto. (See ../../../IROH-V1-DESIGN.md §2.)
 *
 * From CapTP's point of view this is a netlayer swap: the network consumes
 * exactly `transport.connect(hints)` / `transport.listen(handler)` producing
 * a `{ reader, writer }` `ByteStream` of `Uint8Array` chunks, the same as the
 * TCP transport. All CapTP/ocap semantics (attenuation, revocation,
 * swissnums) ride on top unchanged.
 *
 * Identity / discovery boundary (IROH-V1-DESIGN.md §5):
 *
 * - **Dial-by-EndpointId.** `connect`'s `id` hint is a base32 EndpointId.
 *   For our fixed-roster fleet we also carry a direct `addr` hint
 *   (StaticProvider addressing) so a flat-LAN/no-relay pair needs no
 *   discovery server at all — and the explicit addressing doubles as an
 *   allowlist of who can be dialed. Key-only resolution (n0/mDNS discovery)
 *   is deliberately NOT relied upon here; it is unproven on our tailnet.
 *
 * - **Stable EndpointId.** Pass a persisted 32-byte `secretKey` seed so the
 *   EndpointId survives restarts and existing cap-bearing links keep
 *   resolving (mirrors noise-root.mjs's seed persistence).
 *
 * SES placement: the `@number0/iroh` binding is a NAPI addon running in the
 * privileged Node realm, OUTSIDE the SES sandbox — the same boundary the
 * Noise WASM transport occupies. It hands an authenticated byte-stream INTO
 * the confined vat; it must never live inside a compartment.
 *
 * @typedef {import('../types.js').ByteStream} ByteStream
 * @typedef {import('../types.js').OcapnNoiseTransport} OcapnNoiseTransport
 * @typedef {import('../types.js').TransportListener} TransportListener
 */

/**
 * @typedef {object} IrohBiStream
 * @property {{ writeAll(bytes: number[]): Promise<unknown>, finish(): Promise<unknown>, reset(code: bigint): Promise<unknown> }} send
 * @property {{ read(sizeLimit: number): Promise<number[] | undefined | null>, stop(code: bigint): Promise<unknown> }} recv
 */

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';
import { makeNetstringReader, makeNetstringWriter } from '@endo/netstring';

import {
  Endpoint,
  EndpointAddr,
  EndpointId,
  SecretKey,
} from '@number0/iroh';

/**
 * Hard cap on a single netstring frame. QUIC fragments natively, so this
 * is NOT the 65519-byte Noise message ceiling (which the Noise binding
 * imposed and which QUIC dissolves — proven empirically, see
 * iroh-transport.test.js "200KB single frame"). It is purely a
 * denial-of-service guard against a hostile peer sending `999999999:` and
 * forcing a huge allocation in the netstring reader. 16 MiB comfortably
 * spans a CapTP image/blob frame while staying bounded.
 */
const MAX_FRAME_LENGTH = 16 * 1024 * 1024;

/** Default ALPN: which protocol a shared Iroh endpoint speaks. */
const DEFAULT_ALPN = 'field/captp/0';

const textEncoder = new TextEncoder();

/**
 * The binding accepts/returns `Array<number>`, not `Uint8Array`. Adapt at
 * this boundary so the rest of the stack stays portable (forgetting this
 * corrupts framing silently — see IROH-V1-DESIGN.md notes).
 *
 * @param {Uint8Array} u8
 * @returns {number[]}
 */
const toNums = u8 => Array.from(u8);

/**
 * @param {number[]} nums
 * @returns {Uint8Array}
 */
const toU8 = nums => Uint8Array.from(nums);

/**
 * A QUIC connection closing (by either peer) is a normal end-of-stream —
 * the QUIC analogue of a TCP FIN — not an error. The `@number0/iroh`
 * binding surfaces it as a thrown `ConnectionLost(...)` (LocallyClosed /
 * ApplicationClosed / etc.). Classify those as EOF so the reader reports
 * `done: true` like the TCP transport's node reader does on socket close,
 * instead of propagating a rejection up through the CapTP read loop (the
 * teardown pitfall, IROH-V1-DESIGN.md §8). A genuine protocol error (e.g.
 * a reset with a non-zero code, a decode failure) still propagates.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
const isConnectionClosed = err => {
  const msg = String(/** @type {Error} */ (err)?.message || err || '');
  return /ConnectionLost|LocallyClosed|ApplicationClosed|closed|reset|finished/i.test(
    msg,
  );
};

/**
 * Wrap one Iroh bidirectional stream as a raw `{ reader, writer }` of
 * `Uint8Array` chunks, before framing. The reader pulls successive chunks
 * off the QUIC recv stream (an empty/absent read => EOF); the writer pushes
 * chunks down the send stream. Matches the `@endo/stream` async-iterator
 * contract that `makeNodeReader`/`makeNodeWriter` produce for TCP.
 *
 * @param {IrohBiStream} bi
 * @param {() => boolean} [isClosing] true once the transport is shutting
 *   down; a read error during teardown is reported as EOF (clean stream
 *   end) rather than propagating `ConnectionLost(...)` — the teardown
 *   pitfall (IROH-V1-DESIGN.md §8).
 * @returns {ByteStream}
 */
const makeRawByteStream = (bi, isClosing = () => false) => {
  const { send, recv } = bi;

  const reader = harden({
    async next() {
      let nums;
      try {
        nums = await recv.read(1 << 20);
      } catch (err) {
        // A closed/reset QUIC connection is a normal end-of-stream (the
        // TCP-FIN analogue), whether we are tearing down or the peer is.
        if (isClosing() || isConnectionClosed(err)) {
          return harden({ done: true, value: undefined });
        }
        throw err;
      }
      if (!nums || nums.length === 0) {
        return harden({ done: true, value: undefined });
      }
      return harden({ done: false, value: toU8(nums) });
    },
    async return() {
      try {
        await recv.stop(0n);
      } catch {
        // recv may already be closed; teardown is best-effort.
      }
      return harden({ done: true, value: undefined });
    },
    async throw(/** @type {Error} */ err) {
      try {
        await recv.stop(1n);
      } catch {
        // best-effort
      }
      throw err;
    },
    [Symbol.asyncIterator]() {
      return reader;
    },
  });

  const writer = harden({
    async next(/** @type {Uint8Array} */ bytes) {
      await send.writeAll(toNums(bytes));
      return harden({ done: false, value: undefined });
    },
    async return() {
      try {
        await send.finish();
      } catch {
        // best-effort
      }
      return harden({ done: true, value: undefined });
    },
    async throw(/** @type {Error} */ err) {
      try {
        await send.reset(1n);
      } catch {
        // best-effort
      }
      throw err;
    },
    [Symbol.asyncIterator]() {
      return writer;
    },
  });

  return harden({
    reader: /** @type {any} */ (reader),
    writer: /** @type {any} */ (writer),
  });
};

/**
 * Apply netstring framing so each `writer.next(msg)` emits exactly one
 * frame and each `reader.next()` yields exactly one whole message — the
 * contract the Noise handshake and CapTP session messages assume.
 * Identical in spirit to what `tcp.js` does for `'netstring'` framing.
 *
 * @param {ByteStream} raw
 * @returns {ByteStream}
 */
const frame = raw => {
  const reader = /** @type {any} */ (
    makeNetstringReader(raw.reader, { maxMessageLength: MAX_FRAME_LENGTH })
  );
  const writer = /** @type {any} */ (makeNetstringWriter(raw.writer));
  return harden({ reader, writer });
};

/**
 * Create an Iroh QUIC transport.
 *
 * Async (unlike `makeTcpTransport`) because building/binding an Iroh
 * endpoint is asynchronous. `network.addTransport(...)` already awaits its
 * argument's `listen`, so an already-bound endpoint integrates cleanly.
 *
 * @param {object} [options]
 * @param {Uint8Array} [options.secretKey] 32-byte Ed25519 seed for a STABLE
 *   EndpointId across restarts (so cap-bearing links keep resolving). Omit
 *   to generate an ephemeral identity.
 * @param {string} [options.alpn] ALPN protocol id. Default `'field/captp/0'`.
 * @param {'minimal' | 'n0' | 'n0-no-relay'} [options.preset] Discovery/relay
 *   preset. `'minimal'` = direct UDP only, no external deps (flat-LAN /
 *   offline / StaticProvider). `'n0-no-relay'` / `'n0'` add n0 discovery and
 *   relays for cross-NAT use. Default `'minimal'`.
 * @param {'netstring' | 'none'} [options.framing] Default `'netstring'`. As
 *   with `tcp.js`, the OCapN-Noise network requires `'netstring'`; `'none'`
 *   is for callers that frame messages themselves.
 * @param {string} [options.bindAddr] UDP socket to bind. Default
 *   `'0.0.0.0:0'` — an OS-assigned EPHEMERAL QUIC socket, NOT an advertised
 *   service port. Pin only if a fixed addr hint must be baked into links.
 * @returns {Promise<OcapnNoiseTransport & { endpointId: string, endpoint: import('@number0/iroh').Endpoint }>}
 */
export const makeIrohTransport = async ({
  secretKey,
  alpn = DEFAULT_ALPN,
  preset = 'minimal',
  framing = 'netstring',
  bindAddr = '0.0.0.0:0',
} = {}) => {
  if (framing !== 'netstring' && framing !== 'none') {
    throw makeError(
      X`iroh transport: \`framing\` must be 'netstring' or 'none', got ${q(framing)}`,
    );
  }
  if (secretKey !== undefined && secretKey.length !== 32) {
    throw makeError(
      X`iroh transport: secretKey must be a 32-byte seed, got ${q(secretKey.length)} bytes`,
    );
  }

  const alpnBytes = toNums(textEncoder.encode(alpn));

  const builder = Endpoint.builder();
  if (preset === 'minimal') builder.applyMinimal();
  else if (preset === 'n0-no-relay') builder.applyN0DisableRelay();
  else if (preset === 'n0') builder.applyN0();
  else {
    throw makeError(
      X`iroh transport: unknown preset ${q(preset)} (want 'minimal' | 'n0' | 'n0-no-relay')`,
    );
  }
  if (secretKey) builder.secretKey(toNums(secretKey));
  builder.alpns([alpnBytes]);
  builder.bindAddr(bindAddr);

  const endpoint = await builder.bind();
  const myId = endpoint.id().toString();

  let accepting = false;
  // True once shutdown begins. Used to SWALLOW the `ConnectionLost(...)`
  // rejections that QUIC emits when a connection is torn down — the
  // teardown-ordering pitfall (IROH-V1-DESIGN.md §8): closing the endpoint
  // rejects any in-flight `acceptNext()` / `acceptBi()` / `read()`. During
  // normal operation those still surface; only during teardown are they
  // expected and ignorable.
  let closing = false;
  /** @type {Set<import('@number0/iroh').Connection>} */
  const liveConnections = new Set();

  /** @param {import('@number0/iroh').Connection} conn */
  const trackConn = conn => {
    liveConnections.add(conn);
    return conn;
  };

  const isClosing = () => closing;
  /** @param {IrohBiStream} bi @returns {ByteStream} */
  const wrap = bi =>
    framing === 'none'
      ? makeRawByteStream(bi, isClosing)
      : frame(makeRawByteStream(bi, isClosing));

  const transport = harden({
    scheme: 'iroh',
    // Surfaced for callers that need our dialable identity out-of-band
    // (e.g. to bake `iroh:id` into a cap-bearing link). Stable when a
    // `secretKey` seed was supplied.
    endpointId: myId,
    endpoint,

    /**
     * Dial a peer BY EndpointId — no `host:port`.
     *
     * @param {Record<string, string>} hints
     * @param {string} hints.id base32 EndpointId (the peer's Ed25519 pubkey)
     * @param {string} [hints.addr] optional direct `ip:port` (StaticProvider /
     *   no-relay; unnecessary once discovery resolves the id alone)
     * @returns {Promise<ByteStream>}
     */
    connect: async hints => {
      const idStr = hints.id;
      if (idStr === undefined) {
        throw makeError(X`iroh transport: missing 'id' (EndpointId) hint`);
      }
      const id = EndpointId.fromString(idStr);
      const addr = new EndpointAddr(
        id,
        undefined,
        hints.addr ? [hints.addr] : [],
      );
      const conn = trackConn(await endpoint.connect(addr, alpnBytes));
      const bi = await conn.openBi();
      return wrap(/** @type {any} */ (bi));
    },

    /**
     * Start accepting inbound QUIC streams. The returned listener's hints
     * carry `id` (our EndpointId) and `addr` (our bound UDP socket for
     * StaticProvider addressing) — NOT a service `host:port`. The network
     * prefixes these with our `scheme`, yielding `iroh:id` / `iroh:addr`
     * hints in the location instead of `tcp:host` / `tcp:port`.
     *
     * @param {(stream: ByteStream) => void} handler
     * @returns {Promise<TransportListener>}
     */
    listen: async handler => {
      accepting = true;
      // Accept loop: one bidi stream per connection.
      (async () => {
        while (accepting) {
          // eslint-disable-next-line no-await-in-loop
          const incoming = await endpoint.acceptNext();
          if (!incoming) break;
          // eslint-disable-next-line no-await-in-loop
          const accepted = await incoming.accept();
          // eslint-disable-next-line no-await-in-loop
          const conn = trackConn(await accepted.connect());
          conn
            .acceptBi()
            .then(bi => handler(wrap(/** @type {any} */ (bi))))
            .catch(() => {
              // A peer can drop before opening a stream, or we are
              // tearing down (ConnectionLost); ignore either way.
            });
        }
      })().catch(() => {
        // Accept loop ends on shutdown / endpoint close; not fatal.
      });

      const boundSocket = endpoint.boundSockets()[0];
      return harden({
        hints: harden({
          id: myId,
          ...(boundSocket ? { addr: boundSocket } : {}),
        }),
        close: () => {
          accepting = false;
        },
      });
    },

    shutdown: () => {
      accepting = false;
      closing = true;
      // Close each live connection first so its pending acceptBi()/read()
      // settles as an expected ApplicationClose, then close the endpoint.
      // Both `close()` calls return promises that can reject with
      // `ConnectionLost(...)`; swallow them — teardown is best-effort and
      // a closing connection rejecting is exactly what we asked for.
      for (const conn of liveConnections) {
        try {
          Promise.resolve(conn.close(0n, [])).catch(() => {});
        } catch {
          // already closed
        }
      }
      liveConnections.clear();
      // endpoint.close() is async; fire-and-forget to match the sync
      // `shutdown()` signature of the OcapnNoiseTransport interface, and
      // swallow the ConnectionLost(LocallyClosed) it may surface.
      Promise.resolve(endpoint.close()).catch(() => {});
    },
  });
  return transport;
};
harden(makeIrohTransport);
