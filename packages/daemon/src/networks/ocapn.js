// @ts-check
import harden from '@endo/harden';
import { E, Far } from '@endo/far';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';
import { makeCryptography } from '@endo/ocapn/cryptography';
import { makeOcapnNoiseNetwork } from '@endo/ocapn-noise';
import { makeTcpTransport } from '@endo/ocapn-noise/transport/tcp';
import { fromHex, toHex } from '../hex.js';

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

// Domain-separation prefix for the agent-binding signature. Mixed into
// the signed material so a signature produced for this binding cannot
// be replayed as a signature on any other message the agent might be
// asked to sign through its general-purpose `sign` capability. The
// trailing `\0` is a fixed terminator that keeps the prefix unambiguous
// against any extension that prepends data.
const AGENT_BINDING_DOMAIN = 'endo-agent-binding\0';

const textEncoder = new TextEncoder();
const concatBytes = (a, b) => {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
};
const agentBindingMessage = sessionPublicKey =>
  concatBytes(textEncoder.encode(AGENT_BINDING_DOMAIN), sessionPublicKey);

// Format an authority component. IPv6 literals contain colons and must
// be wrapped in brackets so `new URL('proto://[::1]:8080')` and a stored
// `[::1]:8080` listen address both round-trip through URL parsing.
// IPv4 addresses and DNS names have no colons and pass through unchanged.
/**
 * @param {string} host
 * @param {string | number} port
 */
const formatHostPort = (host, port) =>
  host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;

const EndoOcapnBootstrapInterface = M.interface('EndoOcapnBootstrap', {
  getNodeId: M.call().returns(M.string()),
  getAgentBinding: M.call().returns(M.promise()),
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

  const codec = cborCodec;
  const network = makeOcapnNoiseNetwork({ codec });

  // The OCapN-Noise session uses an ephemeral Ed25519 keypair, freshly
  // minted on every install. The daemon's persistent agent identity
  // is *not* baked into the Noise handshake — the agent keypair is
  // confined inside the daemon and never leaves the host (per the
  // `@keypair` capability discipline). Persistent identity is instead
  // layered on top of the session: the bootstrap exo carries a signed
  // attestation (`getAgentBinding`) that endorses this session's
  // ephemeral public key with the agent's persistent key, and the
  // dialing peer verifies that signature against the agent public key
  // it expects from the `endo://` locator before trusting any other
  // capability fetched through this session.
  const signingKeys = network.generateSigningKeys();
  const keyId = network.addSigningKeys(signingKeys);

  // Compute the agent-binding signature now, while we have both the
  // session key (just minted above) and the agent's `sign` capability
  // (passed in via `powers`). The signature endorses
  //   `endo-agent-binding\0` || sessionPublicKey
  // and is verified by any dialing peer against the agent public key
  // it expects from the `endo://` locator. Domain-separating the
  // message keeps this signature unforgeable as a signature on
  // anything else the agent's general-purpose `sign(...)` might be
  // asked to produce.
  const bindingMessage = agentBindingMessage(signingKeys.publicKey);
  const bindingSignature = await E(powers).sign(toHex(bindingMessage));
  const agentBinding = harden({
    agentPublicKey: String(localNodeId),
    signature: bindingSignature,
  });

  // The daemon's bootstrap object: the single entry point a remote
  // peer reaches over an OCapN session. It reports this daemon's node
  // identity, hands back the greeter that runs the handshake, and
  // exposes the agent-binding attestation that ties this session's
  // ephemeral OCapN key to the agent's persistent identity.
  const bootstrap = makeExo('EndoOcapnBootstrap', EndoOcapnBootstrapInterface, {
    getNodeId: () => localNodeId,
    getAgentBinding: async () => agentBinding,
    getGreeter: () => localGreeter,
    help: () =>
      `Endo OCapN bootstrap object. getNodeId() reports this daemon's node number; getAgentBinding() returns the signed attestation that ties this session's OCapN key to the agent; getGreeter() returns the EndoGreeter that runs the peer handshake.`,
  });

  // The OCapN locator (a "nonce locator"): the table of local
  // capabilities a remote peer may fetch by swissnum. The bootstrap
  // is the sole published entry; every other value is reached through
  // the gateway that the greeter hands back from `hello`.
  /** @type {Map<string, unknown>} */
  const locator = new Map();
  locator.set(BOOTSTRAP_SWISSNUM, bootstrap);

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
  // Mirrors `tcp-netstring.js`. IPv6 literals are bracketed so the
  // stored value parses through `new URL('tcp://...')` on restart.
  const resolvedHostPort = formatHostPort(host, boundPort);
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
  const address = `${protocol}://${formatHostPort(hintHost, boundPort)}/?node=${encodedNode}&loc=${encodedLocation}`;

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

    // Establish (or reuse) an OCapN-Noise session up front, so we have
    // an abort handle to race the dial path against cancellation. Wire
    // `connectionCancelled` to abort the session as soon as it
    // materializes — even if cancellation wins the race, the session
    // that does eventually establish will be torn down rather than
    // leaking, and any CapTP work pending on that session rejects with
    // "Session disconnected" rather than hanging.
    const sessionPromise = client.provideSession(remoteLocation);
    const sessionReady = sessionPromise.then(session => {
      connectionCancelled.catch(reason =>
        session.abort(
          /** @type {Error} */ (
            reason instanceof Error ? reason : Error('connection cancelled')
          ),
        ),
      );
      return session;
    });
    await Promise.race([sessionReady, connectionCancelled]);

    // Fetch the remote daemon's bootstrap object by its well-known
    // swissnum. `enlivenSturdyRef` reuses the active session we just
    // established; subsequent CapTP operations naturally fail-fast if
    // cancellation aborts that session out from under them.
    const sturdyRef = client.makeSturdyRef(remoteLocation, BOOTSTRAP_SWISSNUM);
    const remoteBootstrap = await client.enlivenSturdyRef(sturdyRef);
    const remoteGreeterP = E(remoteBootstrap).getGreeter();

    // Verify the layered agent-binding attestation: the OCapN session
    // is authenticated as the *ephemeral* designator from
    // `remoteLocation`, and the binding signature proves the
    // *persistent* agent endorsed that ephemeral key. With both
    // checks, the dialing peer knows the OCapN session it just
    // opened is in fact this agent's session — without ever having
    // pulled the agent's private key out of the daemon.
    const binding = /** @type {{agentPublicKey: string, signature: string}} */ (
      await E(remoteBootstrap).getAgentBinding()
    );
    if (expectedNodeId !== null && binding.agentPublicKey !== expectedNodeId) {
      throw new Error(
        `OCapN peer identity mismatch: address names node ${expectedNodeId} but the binding claims ${binding.agentPublicKey}`,
      );
    }
    // `remoteLocation.designator` is the hex string of the peer's
    // ephemeral OCapN public key (see `buildLocationFor` in
    // `@endo/ocapn-noise/src/network.js`). Decode it to match the
    // bytes the signer mixed into the binding message.
    const sessionPublicKey = fromHex(remoteLocation.designator);
    const cryptography = makeCryptography(codec);
    const publicKeyVerifier = cryptography.makeOcapnPublicKey(
      fromHex(binding.agentPublicKey).buffer,
    );
    // Ed25519 raw signature is 64 bytes (r||s); the OCapN signature
    // value the cryptography helper expects splits those into a
    // structured `{ scheme: 'eddsa', r, s }` (`OcapnSignatureCodec`).
    const sigBytes = fromHex(binding.signature);
    const ocapnSignature = harden({
      type: 'sig-val',
      scheme: 'eddsa',
      r: sigBytes
        .subarray(0, 32)
        .buffer.slice(sigBytes.byteOffset, sigBytes.byteOffset + 32),
      s: sigBytes
        .subarray(32, 64)
        .buffer.slice(sigBytes.byteOffset + 32, sigBytes.byteOffset + 64),
    });
    try {
      publicKeyVerifier.assertSignatureValid(
        agentBindingMessage(sessionPublicKey).buffer,
        /** @type {any} */ (ocapnSignature),
      );
    } catch (_e) {
      throw new Error(
        `OCapN peer identity mismatch: agent binding signature did not verify against the locator's agent public key ${expectedNodeId ?? binding.agentPublicKey}`,
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
