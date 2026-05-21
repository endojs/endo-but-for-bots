// @ts-check
import harden from '@endo/harden';
import { E, Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from '@endo/ocapn-noise';
import { makeTcpTransport } from '@endo/ocapn-noise/transport/tcp';

/**
 * OCapN-Noise transport for daemon-to-daemon (peer) connections.
 *
 * This network module is the OCapN counterpart of `tcp-netstring.js`:
 * the bytes exchanged between two daemons are carried by an
 * authenticated, encrypted OCapN-Noise session rather than by
 * plaintext JSON CapTP. CapTP remains in use on the local edges —
 * daemon-to-worker, daemon-to-CLI, and the browser web gateway — per
 * `designs/daemon-ocapn-external-connectivity.md`.
 *
 * Each daemon registers one bootstrap object — an `EndoOcapnBootstrap`
 * exo — in its OCapN locator under a well-known swissnum. A dialing
 * peer fetches a sturdyref for `(peer location, bootstrap swissnum)`
 * to obtain it. The bootstrap is the single entry point of the peer
 * protocol: it reports the daemon's node identity and hands back the
 * `EndoGreeter` that runs the `hello` handshake. The peer application
 * protocol — `EndoGreeter.hello`, `EndoGateway.provide`,
 * `EndoGateway.followRetentionSet` — rides on top of the OCapN session
 * unchanged, exactly as it rode on CapTP before. This module conforms
 * to the existing `EndoNetwork` interface (`addresses`, `supports`,
 * `connect`) and needs no daemon-core changes to be discovered through
 * `@nets`.
 */

// The well-known OCapN swissnum under which a daemon registers its
// bootstrap object. The bootstrap is the deliberately public entry
// point of the peer protocol, so a fixed name is appropriate;
// everything sensitive is reached only through the gateway the
// greeter hands back from `hello`.
const BOOTSTRAP_SWISSNUM = 'endo-bootstrap';

// Address protocol for OCapN-Noise-over-TCP connection hints.
const protocol = 'ocapn+noise+tcp';

// Optional pet name under which a stored `host:port` listen address
// is read, mirroring `tcp-netstring.js`'s `tcp-listen-addr`.
const LISTEN_ADDR_NAME = 'ocapn-listen-addr';

const EndoOcapnBootstrapInterface = M.interface('EndoOcapnBootstrap', {
  getNodeId: M.call().returns(M.string()),
  getGreeter: M.call().returns(M.any()),
  help: M.call().returns(M.string()),
});

export const make = async (powers, context) => {
  const cancelled = /** @type {Promise<never>} */ (E(context).whenCancelled());

  const { node: localNodeId } = await E(powers).getPeerInfo();
  const localGreeter = await E(powers).greeter();
  const localGateway = await E(powers).gateway();

  // Determine the TCP listen address. Port 0 lets the OS assign an
  // ephemeral port.
  let host = '127.0.0.1';
  let port = 0;
  /** @type {string | undefined} */
  let configuredHostPort;
  try {
    configuredHostPort = /** @type {string} */ (
      await E(powers).lookup(LISTEN_ADDR_NAME)
    );
    const listenUrl = new URL(`tcp://${configuredHostPort}`);
    host = listenUrl.hostname;
    port = listenUrl.port !== '' ? Number(listenUrl.port) : 0;
  } catch {
    // No stored listen address; fall back to an ephemeral local port.
  }

  // The daemon's bootstrap object: the single entry point a remote
  // peer reaches over an OCapN session. It reports this daemon's node
  // identity and hands back the greeter that runs the handshake.
  const bootstrap = makeExo('EndoOcapnBootstrap', EndoOcapnBootstrapInterface, {
    getNodeId: () => localNodeId,
    getGreeter: () => localGreeter,
    help: () =>
      `Endo OCapN bootstrap object. getNodeId() reports this daemon's node number; getGreeter() returns the EndoGreeter that runs the peer handshake.`,
  });

  // The OCapN locator (a "nonce locator"): the table of local
  // capabilities a remote peer may fetch by swissnum. The bootstrap
  // is the sole published entry; every other value is reached through
  // the gateway that the greeter hands back from `hello`.
  /** @type {Map<string, unknown>} */
  const locator = new Map();
  locator.set(BOOTSTRAP_SWISSNUM, bootstrap);

  const codec = cborCodec;
  const network = makeOcapnNoiseNetwork({ codec });

  // TODO(daemon-agent-network-identity): the OCapN-Noise signing key
  // should be the daemon agent's own Ed25519 keypair (the `@keypair`
  // special name) so that the OCapN session identity matches the node
  // number embedded in `endo://` locators. OCapN-Noise needs the raw
  // private key bytes for the Noise handshake, which the keypair
  // capability deliberately does not expose; bridging that gap is the
  // `daemon-agent-network-identity` design. Until it lands, this
  // transport mints a fresh per-network key, so the OCapN peer
  // identity is distinct from the daemon node number and the
  // connection hint must carry both the OCapN location and the node
  // number (which the bootstrap's `getNodeId` lets a peer cross-check).
  const signingKeys = network.generateSigningKeys();
  const keyId = network.addSigningKeys(signingKeys);

  const tcpTransport = makeTcpTransport({ host, port });
  await network.addTransport(tcpTransport);

  const client = await makeOcapn({
    codec,
    // The ocapn-noise network's exported type is defined independently
    // of `@endo/ocapn`'s `OcapnNetwork` and does not structurally
    // unify with it; cast at this single boundary.
    // eslint-disable-next-line object-shorthand
    network: /** @type {any} */ (network),
    locator,
    debugLabel: `endo-peer-${String(localNodeId).slice(0, 8)}`,
  });

  // Our advertised OCapN location, including the transport hints
  // (bound host and port) a peer needs in order to dial us.
  const localLocation = network.locationFor(keyId);
  const localHints = localLocation.hints || {};
  const boundPort = String(localHints['tcp:port'] || port);

  // Persist the resolved listen address so an OS-assigned ephemeral
  // port stays stable across daemon restarts; otherwise every restart
  // would advertise a different port and invalidate stored locators.
  // Mirrors `tcp-netstring.js`.
  const resolvedHostPort = `${host}:${boundPort}`;
  if (resolvedHostPort !== configuredHostPort) {
    await E(powers).storeValue(resolvedHostPort, LISTEN_ADDR_NAME);
  }

  // The connection-hint address embeds both the daemon node id and
  // the full OCapN location, so a dialing peer can reconstruct the
  // location without guessing transport hint keys and can check that
  // it reached the daemon the address names. The dialable transport
  // hints live inside the OCapN location; the `host:port` authority is
  // informational — it keeps the address a well-formed URL so the
  // daemon's `new URL(address)` and `.protocol` checks in `makePeer`
  // continue to work.
  const hintHost = localHints['tcp:host'] || host;
  const encodedNode = encodeURIComponent(String(localNodeId));
  const encodedLocation = encodeURIComponent(JSON.stringify(localLocation));
  const address = `${protocol}://${hintHost}:${boundPort}/?node=${encodedNode}&loc=${encodedLocation}`;

  // `client.shutdown()` tears down the OCapN sessions and the
  // network's transports (closing the TCP listener); shutting the
  // network down again separately would destroy sockets out from
  // under the in-flight session close.
  E.sendOnly(context).addDisposalHook(() => client.shutdown());
  cancelled.catch(() => client.shutdown());

  const connect = async (peerAddress, connectionContext) => {
    const url = new URL(peerAddress);
    const locParam = url.searchParams.get('loc');
    if (locParam === null) {
      throw new Error(
        `OCapN peer address is missing its "loc" parameter: ${peerAddress}`,
      );
    }
    const expectedNodeId = url.searchParams.get('node');
    const remoteLocation = JSON.parse(locParam);

    const connectionCancelled = /** @type {Promise<never>} */ (
      E(connectionContext).whenCancelled()
    );
    const cancelConnection = () => E(connectionContext).cancel();

    // Open an OCapN-Noise session and fetch the remote daemon's
    // bootstrap object by its well-known swissnum.
    const sturdyRef = client.makeSturdyRef(remoteLocation, BOOTSTRAP_SWISSNUM);
    const remoteBootstrap = await client.enlivenSturdyRef(sturdyRef);
    const remoteGreeterP = E(remoteBootstrap).getGreeter();

    // The bootstrap reports the daemon's node identity. Until the
    // OCapN session key is the daemon's own keypair
    // (daemon-agent-network-identity) this is the daemon asserting its
    // id rather than a cryptographic proof, but checking it against
    // the address still catches a stale connection hint that now
    // resolves to a different daemon.
    const reportedNodeId = await E(remoteBootstrap).getNodeId();
    if (expectedNodeId !== null && reportedNodeId !== expectedNodeId) {
      throw new Error(
        `OCapN peer identity mismatch: address names node ${expectedNodeId} but the peer reports ${reportedNodeId}`,
      );
    }

    // Run the peer handshake. `hello` carries our gateway to the peer
    // and returns the peer's gateway to us — the same handshake
    // `tcp-netstring.js` ran over CapTP.
    return E(remoteGreeterP).hello(
      localNodeId,
      localGateway,
      Far('Canceller', cancelConnection),
      connectionCancelled,
    );
  };

  return Far('OcapnNoiseService', {
    addresses: () => harden([address]),
    /** @param {string} addressOrProtocol */
    supports: addressOrProtocol => {
      try {
        return new URL(addressOrProtocol).protocol === `${protocol}:`;
      } catch {
        return (
          addressOrProtocol === `${protocol}:` || addressOrProtocol === protocol
        );
      }
    },
    connect,
  });
};
harden(make);
