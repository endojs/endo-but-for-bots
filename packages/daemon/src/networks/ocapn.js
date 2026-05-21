// @ts-check
import harden from '@endo/harden';
import { E, Far } from '@endo/far';
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
 * The daemon's peer application protocol — `EndoGreeter.hello`,
 * `EndoGateway.provide`, `EndoGateway.followRetentionSet` — rides on
 * top of the OCapN session unchanged, exactly as it rode on CapTP
 * before. This module therefore conforms to the existing
 * `EndoNetwork` interface (`addresses`, `supports`, `connect`) and
 * needs no daemon-core changes to be discovered through `@nets`.
 */

// The OCapN swissnum under which a daemon publishes its `EndoGreeter`
// in its locator so a dialing peer can reach it. A formula
// identifier is unguessable, but the greeter is the deliberately
// public entry point of the peer protocol, so a well-known name is
// appropriate here — everything sensitive is reached only through the
// gateway the greeter hands back.
const GREETER_SWISSNUM = 'endo-greeter';

// Address protocol for OCapN-Noise-over-TCP connection hints.
const protocol = 'ocapn+noise+tcp';

// Optional pet name under which a stored `host:port` listen address
// is read, mirroring `tcp-netstring.js`'s `tcp-listen-addr`.
const LISTEN_ADDR_NAME = 'ocapn-listen-addr';

/**
 * @param {any} powers
 * @param {any} context
 */
export const make = async (powers, context) => {
  const cancelled = /** @type {Promise<never>} */ (E(context).whenCancelled());

  const { node: localNodeId } = await E(powers).getPeerInfo();
  const localGreeter = await E(powers).greeter();
  const localGateway = await E(powers).gateway();

  // Determine the TCP listen address. Port 0 lets the OS assign an
  // ephemeral port.
  let host = '127.0.0.1';
  let port = 0;
  try {
    const hostPort = /** @type {string} */ (
      await E(powers).lookup(LISTEN_ADDR_NAME)
    );
    const listenUrl = new URL(`tcp://${hostPort}`);
    host = listenUrl.hostname;
    port = listenUrl.port !== '' ? Number(listenUrl.port) : 0;
  } catch {
    // No stored listen address; fall back to an ephemeral local port.
  }

  // The OCapN locator (a "nonce locator"): the table of local
  // capabilities a remote peer may fetch by swissnum. The daemon's
  // greeter is the sole published entry; every other value is reached
  // through the gateway that the greeter hands back from `hello`.
  /** @type {Map<string, unknown>} */
  const locator = new Map();
  locator.set(GREETER_SWISSNUM, localGreeter);

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
  // connection hint must carry the full OCapN location.
  const signingKeys = network.generateSigningKeys();
  const keyId = network.addSigningKeys(signingKeys);

  const tcpTransport = makeTcpTransport({ host, port });
  await network.addTransport(tcpTransport);

  const client = await makeOcapn({
    codec,
    network: /** @type {any} */ (network),
    locator,
    debugLabel: `endo-peer-${String(localNodeId).slice(0, 8)}`,
  });

  // Our advertised OCapN location, including the transport hints
  // (bound host and port) a peer needs in order to dial us.
  const localLocation = network.locationFor(keyId);
  const localHints = localLocation.hints || {};

  // The connection-hint address embeds the full OCapN location so a
  // dialing peer can reconstruct it without guessing transport hint
  // keys. The `host:port` authority is informational — it keeps the
  // address a well-formed URL so the daemon's `new URL(address)` and
  // `.protocol` checks in `makePeer` continue to work.
  const hintHost = localHints['tcp:host'] || host;
  const hintPort = localHints['tcp:port'] || String(port);
  const encodedLocation = encodeURIComponent(JSON.stringify(localLocation));
  const address = `${protocol}://${hintHost}:${hintPort}/?loc=${encodedLocation}`;

  const shortKeyId = keyId.slice(0, 8);
  console.error(
    `Endo daemon OCapN-Noise peer transport ready (designator ${shortKeyId} at ${hintHost}:${hintPort})`,
  );

  const shutdown = () => {
    client.shutdown();
    network.shutdown();
  };
  E.sendOnly(context).addDisposalHook(() => shutdown());
  cancelled.catch(() => shutdown());

  /**
   * @param {string} peerAddress
   * @param {any} connectionContext
   */
  const connect = async (peerAddress, connectionContext) => {
    const url = new URL(peerAddress);
    const locParam = url.searchParams.get('loc');
    if (locParam === null) {
      throw new Error(
        `OCapN peer address is missing its "loc" parameter: ${peerAddress}`,
      );
    }
    const remoteLocation = JSON.parse(locParam);

    const connectionCancelled = /** @type {Promise<never>} */ (
      E(connectionContext).whenCancelled()
    );
    const cancelConnection = () => E(connectionContext).cancel();

    // Fetch the remote daemon's greeter through an OCapN-Noise
    // session, then run the peer handshake. `hello` carries our
    // gateway to the peer and returns the peer's gateway to us — the
    // same handshake `tcp-netstring.js` performed over CapTP.
    const sturdyRef = client.makeSturdyRef(remoteLocation, GREETER_SWISSNUM);
    const remoteGreeter = await client.enlivenSturdyRef(sturdyRef);
    return E(remoteGreeter).hello(
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
