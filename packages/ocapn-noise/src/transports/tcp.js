// @ts-check

/**
 * @typedef {import('../types.js').ByteStream} ByteStream
 * @typedef {import('../types.js').OcapnNoiseTransport} OcapnNoiseTransport
 * @typedef {import('../types.js').TransportListener} TransportListener
 */

import net from 'node:net';
import harden from '@endo/harden';
import { makeNodeReader } from '@endo/stream-node/reader.js';
import { makeNodeWriter } from '@endo/stream-node/writer.js';
import { makeGracefulReader } from '@endo/stream-node/graceful-reader.js';
import { makeNetstringReader, makeNetstringWriter } from '@endo/netstring';
import { bracketHost, computeAdvertisedHosts } from './advertised-hosts.js';

const { isNaN } = Number;

/**
 * Hard cap on netstring frame length. Sized to the largest plausible
 * single Noise/OCapN message (Noise's 65535-byte ciphertext + auth tag
 * + a small framing header). Keeps a hostile peer who sends
 * `999999999:` from causing a ~1 GiB allocation in the netstring
 * reader.
 */
const MAX_FRAME_LENGTH = 65_551;

// A destroyed socket (which `shutdown()` does, and which a peer crash
// produces) rejects any pending `reader.next()` with
// `ERR_STREAM_PREMATURE_CLOSE`; a destroyed socket *is* a closed stream, so
// `makeGracefulReader` converts that rejection into an orderly
// `{ done: true }` for the session layer above. See
// `@endo/stream-node/graceful-reader.js`.

/**
 * TCP byte-stream transport.
 *
 * `framing` controls how messages are delimited on the wire:
 *
 * - `'netstring'` (default): every `writer.next(bytes)` emits one
 *   `@endo/netstring`-framed message and every `reader.next()` yields
 *   one whole message, regardless of how the kernel chunks the wire
 *   bytes. This is what OCapN-Noise needs once its own handshake is
 *   complete and session messages start flowing.
 *
 * - `'none'`: raw bytes in, raw bytes out. Each `reader.next()` value
 *   is whatever the kernel happened to deliver (possibly a fragment,
 *   possibly multiple messages concatenated). This mode exists to let
 *   us interoperate with peers that do their own framing (e.g. the
 *   OCapN Python reference suite while it settles). Consumers of this
 *   mode are responsible for their own message boundaries. The
 *   OCapN-Noise network is **not** such a consumer: its handshake and
 *   per-session messages assume one `reader.next()` yields exactly one
 *   message. Do not register a `framing: 'none'` transport with
 *   `makeOcapnNoiseNetwork`; use it only when wiring the transport
 *   into something that frames messages itself.
 *
 * @param {object} [options]
 * @param {number} [options.port] - Listen port. `0` = OS-assigned.
 * @param {string} [options.host] - Listen host. Default `'127.0.0.1'`.
 * @param {'netstring' | 'none'} [options.framing] - Default `'netstring'`.
 * @param {string[]} [options.hosts] - Explicit override for the hosts to
 *   advertise (IPv6-first), bypassing interface enumeration. A deliberate
 *   caller choice, honored as given (loopback included).
 * @param {() => (string[] | Promise<string[]>)} [options.discoverHosts] -
 *   Pluggable public-IP discovery seam. Its results are folded into the
 *   advertised hint list (after interface enumeration, loopback dropped).
 *   This transport ships only the seam; wire STUN or a reflector here.
 * @returns {OcapnNoiseTransport}
 */
export const makeTcpTransport = ({
  port = 0,
  host = '127.0.0.1',
  framing = 'netstring',
  hosts,
  discoverHosts,
} = {}) => {
  if (framing !== 'netstring' && framing !== 'none') {
    throw Error(
      `tcp transport: \`framing\` must be 'netstring' or 'none', got ${JSON.stringify(framing)}`,
    );
  }

  /** @type {Set<net.Socket>} */
  const openSockets = new Set();
  /** @type {net.Server | undefined} */
  let server;

  /**
   * @param {net.Socket} socket
   * @returns {ByteStream}
   */
  const wrap = socket => {
    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
    // Without an `error` listener, an `error` event before any reader
    // is iterating will crash the process via Node's "uncaught" path.
    // The Node reader installs its own listener once iteration starts,
    // but until then we need a no-op so the event doesn't become fatal.
    socket.on('error', () => {});
    const rawReader = makeNodeReader(socket);
    const rawWriter = makeNodeWriter(socket);
    if (framing === 'none') {
      return harden({
        reader: /** @type {any} */ (makeGracefulReader(rawReader)),
        writer: /** @type {any} */ (rawWriter),
      });
    }
    const reader = /** @type {any} */ (
      makeGracefulReader(
        /** @type {any} */ (
          makeNetstringReader(rawReader, { maxMessageLength: MAX_FRAME_LENGTH })
        ),
      )
    );
    const writer = /** @type {any} */ (makeNetstringWriter(rawWriter));
    return harden({ reader, writer });
  };

  /** @type {OcapnNoiseTransport} */
  const transport = harden({
    scheme: 'tcp',
    connect: async hint => {
      // A single self-describing `tcp://host:port` dial URL — one entry
      // from the peer's priority-ordered hint list, already matched to
      // this transport's `tcp` scheme by the network.
      if (hint === undefined) {
        throw Error(`tcp transport: missing dial hint`);
      }
      let parsed;
      try {
        parsed = new URL(hint);
      } catch {
        throw Error(`tcp transport: invalid dial hint ${hint}`);
      }
      if (parsed.protocol !== 'tcp:') {
        throw Error(`tcp transport: dial hint must be a tcp: URL, got ${hint}`);
      }
      // For the non-special `tcp:` scheme WHATWG URL keeps IPv6 literals
      // bracketed (e.g. `[::1]`); strip them for `net.createConnection`.
      let hintHost = parsed.hostname || '127.0.0.1';
      if (hintHost.startsWith('[') && hintHost.endsWith(']')) {
        hintHost = hintHost.slice(1, -1);
      }
      const portStr = parsed.port;
      if (portStr === '') {
        throw Error(`tcp transport: dial hint missing port ${hint}`);
      }
      const portNum = Number.parseInt(portStr, 10);
      if (isNaN(portNum)) {
        throw Error(`tcp transport: invalid port in dial hint ${hint}`);
      }
      const socket = net.createConnection({ host: hintHost, port: portNum });
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      return wrap(socket);
    },
    listen: async handler => {
      const srv = net.createServer(socket => handler(wrap(socket)));
      server = srv;
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, host, () => {
          srv.removeListener('error', reject);
          resolve(undefined);
        });
      });
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        throw Error(`tcp transport: unexpected address ${addr}`);
      }
      // Advertise a priority-ordered list of dial URLs — one per routable
      // link-layer address (IPv6 first), plus any pluggably-discovered
      // public address. A wildcard bind that resolves to nothing routable
      // advertises an empty list rather than an undialable loopback URL.
      // IPv6 literals are bracketed so each advertised URL round-trips
      // back through `new URL()` on the connecting peer.
      const advHosts = await computeAdvertisedHosts({
        bindHost: host,
        boundAddress: addr.address,
        hosts,
        discoverHosts,
      });
      const hints = advHosts.map(
        advHost => `tcp://${bracketHost(advHost)}:${addr.port}`,
      );
      /** @type {TransportListener} */
      const listener = harden({
        hints,
        close: () => {
          srv.close();
        },
      });
      return listener;
    },
    shutdown: () => {
      if (server) server.close();
      for (const socket of openSockets) socket.destroy();
      openSockets.clear();
    },
  });
  return transport;
};
