// @ts-check

/**
 * Single-endpoint projection into a `network: 'none'` slice.
 *
 * The network profile ladder (`none`, `private`, `host-loopback`, `host-lan`,
 * `host-net`) cannot express "one daemon-side endpoint and nothing else".
 * `none` blocks the endpoint along with everything else, and `host-loopback`
 * shares the host's entire loopback namespace — every local service the
 * operator happens to be running, not the one the slice was granted. A
 * projection is the missing rung, and it is not a rung on that ladder at all:
 * it is an authority handed to one slice, not a posture selected for it.
 *
 * The projection has two halves.
 *
 * Daemon side, `makeEndpointProjectionService` serves one Unix socket per
 * projection and dials the granted `EndpointDialer` once per accepted
 * connection. The dialer is a capability, never an address: a holder of a
 * slice handle can project only an endpoint it was already given, so
 * projecting is not a way to name a host port.
 *
 * Slice side, `src/net/forward-endpoint.js` runs inside the network namespace
 * the slice will share, binds the loopback TCP listener the slice dials, and
 * copies bytes to that socket. See that module for why the endpoint has to be
 * TCP and why the forwarder sits outside the slice's confinement.
 *
 * Every misconfiguration here is a hard error. Nothing in this module ever
 * responds to an unusable request by widening the slice's network profile —
 * the same discipline the `blocked-ranges` / `private-egress.nft` helpers keep
 * for the ladder itself.
 */

import { E } from '@endo/eventual-send';
import { makeError, q, X } from '@endo/errors';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';

/** @import { EndpointDialer, EndpointProjectionSpec } from '../types.js' */

/**
 * The only profile a projection may be minted against.
 *
 * `none` is the profile whose namespace is empty, which is exactly what makes
 * "one endpoint and nothing else" true. On a `host-*` profile the slice shares
 * the host's network namespace, so a loopback listener would sit on the host's
 * loopback and be reachable by every other slice and process there; that is
 * the whole-loopback sharing a projection exists to avoid. `private` carries
 * its own egress posture, which a projection neither implements nor overrides.
 */
export const PROJECTABLE_NETWORK_PROFILES = harden(['none']);
harden(PROJECTABLE_NETWORK_PROFILES);

/**
 * Ports below 1024 need `CAP_NET_BIND_SERVICE`, which the forwarder does not
 * hold for its mapped user; a slice asking for one would fail at bind time
 * with an opaque EACCES instead of at mint time with a diagnosis.
 */
const MIN_PROJECTED_PORT = 1024;
const MAX_PROJECTED_PORT = 65_535;

/** The port a projection uses when the caller names none. */
export const DEFAULT_PROJECTED_PORT = 8080;
harden(DEFAULT_PROJECTED_PORT);

/**
 * The slice-visible loopback address. Not configurable: the projection's claim
 * is that the endpoint is namespace-local, and any other address would either
 * be unreachable or would not be.
 */
export const PROJECTED_HOST = '127.0.0.1';
harden(PROJECTED_HOST);

/** The environment variable a projected slice finds its endpoint in. */
export const DEFAULT_PROJECTED_ORIGIN_ENV = 'ENDO_PROJECTED_ORIGIN';
harden(DEFAULT_PROJECTED_ORIGIN_ENV);

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Refuse a projection against a profile that cannot honour its contract.
 *
 * @param {string} network
 * @returns {void}
 */
export const assertProjectableNetwork = network => {
  if (!PROJECTABLE_NETWORK_PROFILES.includes(network)) {
    throw makeError(
      X`projectEndpoint: network profile ${q(network)} cannot carry a single-endpoint projection; only ${q(PROJECTABLE_NETWORK_PROFILES)} confines the endpoint to this slice`,
    );
  }
};
harden(assertProjectableNetwork);

/**
 * Normalize and validate the caller-facing projection options.
 *
 * @param {{ port?: number, envName?: string }} [options]
 * @returns {{ host: string, port: number, envName: string }}
 */
export const normalizeProjectionOptions = (options = {}) => {
  const { port = DEFAULT_PROJECTED_PORT, envName = DEFAULT_PROJECTED_ORIGIN_ENV } =
    options;
  if (
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < MIN_PROJECTED_PORT ||
    port > MAX_PROJECTED_PORT
  ) {
    throw makeError(
      X`projectEndpoint: port must be an integer in [${q(MIN_PROJECTED_PORT)}, ${q(MAX_PROJECTED_PORT)}], got ${q(port)}`,
    );
  }
  if (typeof envName !== 'string' || !ENV_NAME.test(envName)) {
    throw makeError(
      X`projectEndpoint: envName must match ${q(String(ENV_NAME))}, got ${q(envName)}`,
    );
  }
  return harden({ host: PROJECTED_HOST, port, envName });
};
harden(normalizeProjectionOptions);

/**
 * The origin a slice dials. It carries no secret: the pathname of the
 * daemon-side socket never crosses into the slice, the socket is per
 * projection, and a projection outlives no operation. A consumer that needs
 * request-level routing may add a per-operation random path prefix of its own;
 * nothing here requires one, and nothing here will carry a credential that
 * means anything outside this projection.
 *
 * @param {{ host: string, port: number }} endpoint
 * @returns {string}
 */
export const projectedOrigin = ({ host, port }) => `http://${host}:${port}`;
harden(projectedOrigin);

/**
 * Copy every byte a source yields into a sink, then close the sink.
 *
 * A failure on either end ends the copy rather than propagating: a projection
 * that loses one direction has already lost the connection, and the other
 * pump's own close is what tells its peer.
 *
 * @param {AsyncIterable<Uint8Array>} source
 * @param {{ next: (chunk: Uint8Array) => Promise<unknown>, return: (value?: any) => Promise<unknown> }} sink
 * @returns {Promise<void>}
 */
const pump = async (source, sink) => {
  await null;
  try {
    for await (const chunk of source) {
      await sink.next(chunk);
    }
  } catch (_error) {
    // Fall through to the close below; the peer learns from the close.
  }
  await sink.return(undefined).catch(() => {});
};

/**
 * Serve the daemon-side half of a projection.
 *
 * One Unix socket, one dialer. Each accepted connection is answered by a fresh
 * `E(dialer).connect()`, so a dialer that has stopped answering closes
 * reachability without the projection having to know why. `close()` releases
 * the socket and settles only once it is gone, so a caller that revokes can
 * await the absence of the endpoint rather than assume it.
 *
 * @param {object} args
 * @param {EndpointDialer} args.dialer
 * @param {string} args.socketPath
 * @param {(opts: { path: string, cancelled: Promise<never> }) => Promise<{
 *   connections: AsyncIterable<{ reader: AsyncIterable<Uint8Array>, writer: any, closed: Promise<unknown> }>,
 *   close: () => Promise<void>,
 * }>} args.serveSocketPath
 * @param {Promise<never>} args.cancelled
 * @returns {Promise<{ close: () => Promise<void>, connectionCount: () => number }>}
 */
export const serveEndpointProjection = async ({
  dialer,
  socketPath,
  serveSocketPath,
  cancelled,
}) => {
  const listener = await serveSocketPath({ path: socketPath, cancelled });
  let connectionCount = 0;

  // Deliberately not awaited: the accept loop runs for the projection's life.
  // Its only failure mode of interest is the listener closing, which is what
  // `close()` does on purpose.
  void (async () => {
    await null;
    for await (const { reader, writer, closed } of listener.connections) {
      connectionCount += 1;
      void (async () => {
        await null;
        /** @type {{ reader: unknown, writer: unknown } | undefined} */
        let upstream;
        try {
          upstream = await E(dialer).connect();
        } catch (_error) {
          // The granted endpoint is gone or refusing. Hang up rather than
          // hold a slice-side connection open against nothing.
          await writer.return(undefined).catch(() => {});
          return;
        }
        // The dialer's ends are `@endo/exo-stream` passables, so a granted
        // endpoint may live in another vat; the accepted end is this vat's own
        // socket. Both directions are copied until either closes.
        const up = /** @type {{ reader: any, writer: any }} */ (upstream);
        const fromEndpoint = iterateBytesReader(up.reader);
        const toEndpoint = iterateBytesWriter(up.writer);
        await Promise.race([
          Promise.all([pump(reader, toEndpoint), pump(fromEndpoint, writer)]),
          closed,
        ]).catch(() => {});
      })();
    }
  })().catch(() => {});

  return harden({
    close: () => listener.close(),
    connectionCount: () => connectionCount,
  });
};
harden(serveEndpointProjection);

/**
 * Describe the projection to a driver: everything a backend needs in order to
 * put the endpoint in front of a slice, and nothing that names an authority.
 *
 * @param {object} args
 * @param {string} args.socketPath
 * @param {string} args.host
 * @param {number} args.port
 * @param {string} args.envName
 * @returns {EndpointProjectionSpec}
 */
export const makeEndpointProjectionSpec = ({
  socketPath,
  host,
  port,
  envName,
}) =>
  harden({
    socketPath,
    host,
    port,
    envName,
    origin: projectedOrigin({ host, port }),
  });
harden(makeEndpointProjectionSpec);
