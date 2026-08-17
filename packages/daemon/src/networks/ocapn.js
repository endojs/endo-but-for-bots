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
import { bytesFromText } from '@endo/bytes/from-string.js';
import { concatBytes } from '@endo/bytes/concat.js';
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
 * OCapN's own bootstrap is the implicit first export of a session
 * (export position 0), reached with no swissnum via
 * `session.getBootstrap()`; the spec provides no swissnum for it. In
 * `@endo/ocapn` that position-0 object is a protocol-fixed surface
 * exposing `fetch(swissnum)` and the three-party-handoff gift methods
 * (`makeBootstrapObject`, `packages/ocapn/src/client/ocapn.js`), not an
 * application object we control. Application capabilities are therefore
 * reached *through* the bootstrap by a swissnum: `bootstrap.fetch(sn)`
 * resolves `sn` against the peer's locator, which is exactly what
 * `makeSturdyRef(location, sn)` + `enlivenSturdyRef` wrap.
 *
 * So each daemon publishes one peer entry-point capability — an
 * `EndoPeerEntry` exo — in its OCapN locator under a single well-known
 * swissnum, and a dialing peer fetches a sturdyref for
 * `(peer location, entry swissnum)` to obtain it. This entry object is
 * *not* the OCapN bootstrap; it is an ordinary capability we reach
 * through the bootstrap's `fetch`. Its extra methods relative to the
 * conventional CapTP daemon bootstrap (which is the `EndoGreeter`
 * itself — see `tcp-netstring.js`, where `getBootstrap()` returns the
 * greeter and `hello` is called on it directly) exist to carry the
 * layered agent-binding attestation described below: it reports the
 * daemon's persistent node identity, exposes the signed binding that
 * ties this session's ephemeral OCapN key to that identity, and hands
 * back the `EndoGreeter` that runs the `hello` handshake. The peer
 * application protocol — `EndoGreeter.hello`, `EndoGateway.provide`,
 * `EndoGateway.followRetentionSet` — rides on top of the OCapN session
 * unchanged, exactly as it rode on CapTP before. This module conforms
 * to the existing `EndoNetwork` interface (`addresses`, `supports`,
 * `connect`) and needs no daemon-core changes to be discovered through
 * `@nets`.
 */

// The well-known OCapN swissnum under which a daemon publishes its peer
// entry-point capability in its locator. This is *not* the OCapN
// bootstrap (which is the implicit position-0 export, reached with no
// swissnum); it is an ordinary capability a dialing peer fetches through
// that bootstrap via `bootstrap.fetch(PEER_ENTRY_SWISSNUM)`. The entry
// point is deliberately public, so a fixed name is appropriate;
// everything sensitive is reached only through the gateway the greeter
// hands back from `hello`.
const PEER_ENTRY_SWISSNUM = 'endo-peer-entry';

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

const agentBindingMessage = sessionPublicKey =>
  concatBytes([bytesFromText(AGENT_BINDING_DOMAIN), sessionPublicKey]);

// Format an authority (`host:port`) component. IPv6 literals contain
// colons and must be wrapped in brackets so `new URL('proto://[::1]:8080')`
// and a stored `[::1]:8080` listen address both round-trip through URL
// parsing. IPv4 addresses and DNS names have no colons and pass through
// unchanged.
//
// We cannot *construct* the authority through the `URL` interface, even
// though that would be the natural way to gain its validation: the
// `URL`/`URLSearchParams` API has no host-formatting entry point, and
// its `hostname` setter silently *rejects* a bare IPv6 literal rather
// than bracketing it — `(u => { u.hostname = '::1'; return u.host })` on
// a fresh `new URL('null://x')` leaves the placeholder host untouched
// (a colon is not a valid opaque-host character in the WHATWG URL spec,
// so the setter is a no-op; verified on Node 22), so a URL-built
// authority would silently drop every IPv6 address. Bracketing therefore
// stays a manual string operation.
//
// We still drive *validation* through `URL` to gain the confidence and
// the meaningful errors the reviewer asked for: after bracketing we
// parse the result back and assert the host and port survive the round
// trip, so an invalid host or an out-of-range port fails loudly here
// with a specific message instead of producing a malformed address that
// only breaks later at the dialing peer.
/**
 * @param {string} host
 * @param {string | number} port
 * @returns {string} the `host:port` authority, IPv6 host bracketed
 */
export const formatHostPort = (host, port) => {
  const authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  // Round-trip through URL to validate. `tcp:` is an arbitrary parseable
  // scheme; only the authority is under test. Port 0 (an as-yet-unbound
  // ephemeral port) is the one legitimate value URL normalizes away
  // (`.port === ''`), so it is exempt from the port round-trip check.
  let url;
  try {
    url = new URL(`tcp://${authority}`);
  } catch (cause) {
    throw Error(
      `Cannot format OCapN authority from host ${JSON.stringify(
        host,
      )} and port ${JSON.stringify(port)}: ${authority} is not a valid URL authority`,
      { cause },
    );
  }
  // Compare the parsed host against the bracket-free host the caller
  // supplied. `tcp:` is a non-special scheme, so URL preserves the host
  // verbatim (no lowercasing/IDNA); the only normalization to undo is the
  // IPv6 brackets, which we strip from both sides.
  const bareHost = host.replace(/^\[|\]$/g, '');
  if (url.hostname.replace(/^\[|\]$/g, '') !== bareHost) {
    throw Error(
      `Cannot format OCapN authority: host ${JSON.stringify(
        host,
      )} did not survive URL round-trip (got ${JSON.stringify(url.hostname)})`,
    );
  }
  if (String(port) !== '0' && url.port !== String(port)) {
    throw Error(
      `Cannot format OCapN authority: port ${JSON.stringify(
        port,
      )} did not survive URL round-trip (got ${JSON.stringify(url.port)})`,
    );
  }
  return authority;
};

// Whether this network can dial the given address (or bare protocol
// string). Captures no lexical state — it reads only the module-level
// `protocol` constant — so it lives at module scope rather than being
// reallocated inside every `make()` call.
/** @param {string} addressOrProtocol */
const supports = addressOrProtocol => {
  try {
    return new URL(addressOrProtocol).protocol === `${protocol}:`;
  } catch {
    // The caller may pass just the protocol string (e.g.
    // "ocapn+noise+tcp:") rather than a full address.
    return (
      addressOrProtocol === `${protocol}:` || addressOrProtocol === protocol
    );
  }
};

const EndoPeerEntryInterface = M.interface('EndoPeerEntry', {
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
    // `URL.hostname` returns an IPv6 literal *bracketed* (`[::1]`);
    // strip the brackets so `host` is the bare address that
    // `formatHostPort` expects (it re-brackets), rather than a
    // double-bracketed `[[::1]]`.
    host = listenUrl.hostname.replace(/^\[|\]$/g, '');
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
  // layered on top of the session: the peer entry-point exo carries a signed
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

  // The daemon's peer entry-point capability: the single object a remote
  // peer reaches over an OCapN session by fetching PEER_ENTRY_SWISSNUM
  // through the peer's bootstrap. It reports this daemon's node identity,
  // hands back the greeter that runs the handshake, and exposes the
  // agent-binding attestation that ties this session's ephemeral OCapN
  // key to the agent's persistent identity.
  const peerEntry = makeExo('EndoPeerEntry', EndoPeerEntryInterface, {
    getNodeId: () => localNodeId,
    getAgentBinding: async () => agentBinding,
    getGreeter: () => localGreeter,
    help: () =>
      `Endo OCapN peer entry-point object (fetched through the OCapN bootstrap by a well-known swissnum; not itself the OCapN bootstrap). getNodeId() reports this daemon's node number; getAgentBinding() returns the signed attestation that ties this session's OCapN key to the agent; getGreeter() returns the EndoGreeter that runs the peer handshake.`,
  });

  // The OCapN locator (a "nonce locator"): the table of local
  // capabilities a remote peer may fetch by swissnum through the OCapN
  // bootstrap's `fetch`. The peer entry point is the sole published
  // entry; every other value is reached through the gateway that the
  // greeter hands back from `hello`.
  /** @type {Map<string, unknown>} */
  const locator = new Map();
  locator.set(PEER_ENTRY_SWISSNUM, peerEntry);

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
  // Strip any IPv6 brackets the transport hint may carry, for the same
  // reason as the listen host above: `formatHostPort` expects a bare host.
  const hintHost = (localHints['tcp:host'] || host).replace(/^\[|\]$/g, '');
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

    // Fetch the remote daemon's peer entry-point capability by its
    // well-known swissnum (through the peer's OCapN bootstrap).
    // `enlivenSturdyRef` reuses the active session we just established;
    // subsequent CapTP operations naturally fail-fast if cancellation
    // aborts that session out from under them.
    const sturdyRef = client.makeSturdyRef(remoteLocation, PEER_ENTRY_SWISSNUM);
    const remotePeerEntry = await client.enlivenSturdyRef(sturdyRef);
    const remoteGreeterP = E(remotePeerEntry).getGreeter();

    // Verify the layered agent-binding attestation: the OCapN session
    // is authenticated as the *ephemeral* designator from
    // `remoteLocation`, and the binding signature proves the
    // *persistent* agent endorsed that ephemeral key. With both
    // checks, the dialing peer knows the OCapN session it just
    // opened is in fact this agent's session — without ever having
    // pulled the agent's private key out of the daemon.
    const binding = /** @type {{agentPublicKey: string, signature: string}} */ (
      await E(remotePeerEntry).getAgentBinding()
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
    supports,
    connect,
  });
};
harden(make);
