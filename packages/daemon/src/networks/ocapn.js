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
import { makeWebSocketTransport } from '@endo/ocapn-noise/transport/ws';
import { concatBytes } from '@endo/bytes/concat.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';
// The OCapN network module is loaded unconfined (`makeUnconfined` in
// `setup-ocapn.js`), so — exactly like `ws-relay.js` and the TCP
// transport's `import net from 'node:net'` — it obtains its Node
// WebSocket powers by importing them here at the module top, then
// threads them into the transport rather than letting confined code
// reach for `ws` ambiently.
import { WebSocket, WebSocketServer } from 'ws';
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

// Address protocol for OCapN-Noise-over-WebSocket connection hints. The
// WS variant is what the target deployment host (minion.town) can serve,
// since it exposes only 443/WS; TCP and WS share the same Noise session
// layer and differ only in the byte-stream transport underneath.
const wsProtocol = 'ocapn+noise+ws';

// Optional pet name under which a stored `host:port` listen address
// is read, mirroring `tcp-netstring.js`'s `tcp-listen-addr`.
const LISTEN_ADDRESS_NAME = 'ocapn-listen-addr';

// Optional pet name for the WebSocket listen address, parallel to
// `ocapn-listen-addr`. Its presence is what enables the WS transport;
// see the transport-gating logic in `make`.
const WS_LISTEN_ADDRESS_NAME = 'ws-listen-addr';

// Domain-separation prefix for the agent-binding signature. Mixed into
// the signed material so a signature produced for this binding cannot
// be replayed as a signature on any other message the agent might be
// asked to sign through its general-purpose `sign` capability. The
// trailing `\0` is a fixed terminator that keeps the prefix unambiguous
// against any extension that prepends data.
const AGENT_BINDING_DOMAIN = 'endo-agent-binding\0';

const agentBindingMessage = sessionPublicKey =>
  concatBytes([encodeUtf8(AGENT_BINDING_DOMAIN), sessionPublicKey]);

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
  const authority = host.includes(':')
    ? `[${host}]:${port}`
    : `${host}:${port}`;
  // Round-trip through URL to validate. `tcp:` is an arbitrary parseable
  // scheme; only the authority is under test. Port 0 (an as-yet-unbound
  // ephemeral port) is the one legitimate value URL normalizes away
  // (`.port === ''`), so it is exempt from the port round-trip check.
  let url;
  try {
    url = new URL(`tcp://${authority}`);
  } catch (cause) {
    throw new Error(
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
    throw new Error(
      `Cannot format OCapN authority: host ${JSON.stringify(
        host,
      )} did not survive URL round-trip (got ${JSON.stringify(url.hostname)})`,
    );
  }
  if (String(port) !== '0' && url.port !== String(port)) {
    throw new Error(
      `Cannot format OCapN authority: port ${JSON.stringify(
        port,
      )} did not survive URL round-trip (got ${JSON.stringify(url.port)})`,
    );
  }
  return authority;
};

// Whether this network can dial the given address (or bare protocol
// string), given the transports enabled for this instance.
/**
 * @param {string} addressOrProtocol
 * @param {Set<string>} enabledProtocols
 */
const supports = (addressOrProtocol, enabledProtocols) => {
  let candidateProtocol;
  try {
    candidateProtocol = new URL(addressOrProtocol).protocol;
  } catch {
    // The caller may pass just the protocol string (e.g.
    // "ocapn+noise+tcp:") rather than a full address.
    candidateProtocol = addressOrProtocol.endsWith(':')
      ? addressOrProtocol
      : `${addressOrProtocol}:`;
  }
  return enabledProtocols.has(candidateProtocol);
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

  // Read an optional stored `host:port` listen address by pet name.
  // Returns `undefined` when the name is unset. Port 0 (or an absent
  // port) lets the OS assign an ephemeral port. The `scheme` is only a
  // URL-parsing vehicle for the `host:port` authority; it never leaves
  // this function.
  /**
   * @param {string} name
   * @param {'tcp' | 'ws'} scheme
   * @returns {Promise<{ configured: string, host: string, port: number } | undefined>}
   */
  const readListenAddress = async (name, scheme) => {
    /** @type {string} */
    let configured;
    try {
      configured = /** @type {string} */ (await E(powers).lookup(name));
    } catch {
      return undefined;
    }
    const listenUrl = new URL(`${scheme}://${configured}`);
    return {
      configured,
      host: listenUrl.hostname.replace(/^\[|\]$/g, ''),
      port: listenUrl.port !== '' ? Number(listenUrl.port) : 0,
    };
  };

  // Transport gating. TCP is enabled by `ocapn-listen-addr`, WS by
  // `ws-listen-addr`; a daemon may enable either or both. When neither
  // is configured we default to an ephemeral TCP listener so an
  // unconfigured daemon keeps its historical TCP-only behavior.
  const tcpConfig = await readListenAddress(LISTEN_ADDRESS_NAME, 'tcp');
  const wsConfig = await readListenAddress(WS_LISTEN_ADDRESS_NAME, 'ws');
  const enableTcp = tcpConfig !== undefined || wsConfig === undefined;
  const enableWs = wsConfig !== undefined;

  const tcpHost = tcpConfig?.host ?? '127.0.0.1';
  const tcpPort = tcpConfig?.port ?? 0;
  const enabledProtocols = new Set([
    ...(enableTcp ? [`${protocol}:`] : []),
    ...(enableWs ? [`${wsProtocol}:`] : []),
  ]);

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

  if (enableTcp) {
    const tcpTransport = makeTcpTransport({ host: tcpHost, port: tcpPort });
    await network.addTransport(tcpTransport);
  }
  if (enableWs) {
    // The WS transport needs both a `WebSocket` client constructor (to
    // dial) and a `WebSocketServer` constructor (to listen); both are
    // supplied from the module-top `ws` import so confined code never
    // reaches for `ws` itself.
    const wsTransport = makeWebSocketTransport({
      // The `ws` package's `WebSocket` constructor is structurally a
      // browser `WebSocket` for the transport's purposes but does not
      // unify with the DOM `WebSocket` lib type; cast at this boundary.
      // eslint-disable-next-line object-shorthand
      WebSocket: /** @type {any} */ (WebSocket),
      WebSocketServer,
      host: /** @type {{ host: string }} */ (wsConfig).host,
      port: /** @type {{ port: number }} */ (wsConfig).port,
    });
    await network.addTransport(wsTransport);
  }

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
  // (bound host and port for TCP; a `ws://host:port` url for WS) a peer
  // needs in order to dial us. The location carries the hints for every
  // enabled transport, so each per-protocol address below embeds the
  // same `loc` and differs only in scheme and informational authority.
  const localLocation = network.locationFor(keyId);
  const localHints = localLocation.hints || {};

  // The connection-hint address embeds both the daemon node id and
  // the full OCapN location, so a dialing peer can reconstruct the
  // location without guessing transport hint keys and can check that
  // it reached the daemon the address names. The dialable transport
  // hints live inside the OCapN location; the `host:port` authority is
  // informational — it keeps the address a well-formed URL so the
  // daemon's `new URL(address)` and `.protocol` checks in `makePeer`
  // continue to work.
  const encodedNode = encodeURIComponent(String(localNodeId));
  const encodedLocation = encodeURIComponent(JSON.stringify(localLocation));

  /** @type {string[]} */
  const addresses = [];

  if (enableTcp) {
    const boundPort = String(localHints['tcp:port'] || tcpPort);

    // Persist the resolved listen address so an OS-assigned ephemeral
    // port stays stable across daemon restarts; otherwise every restart
    // would advertise a different port and invalidate stored locators.
    // Mirrors `tcp-netstring.js`. IPv6 literals are bracketed so the
    // stored value parses through `new URL('tcp://...')` on restart.
    const resolvedHostPort = formatHostPort(tcpHost, boundPort);
    if (resolvedHostPort !== tcpConfig?.configured) {
      await E(powers).storeValue(resolvedHostPort, LISTEN_ADDRESS_NAME);
    }

    const hintHost = String(localHints['tcp:host'] || tcpHost).replace(
      /^\[|\]$/g,
      '',
    );
    addresses.push(
      `${protocol}://${formatHostPort(hintHost, boundPort)}/?node=${encodedNode}&loc=${encodedLocation}`,
    );
  }

  if (enableWs) {
    // The WS listener advertises a single aggregated `ws:url` hint
    // (`ws://host:port`) rather than the separate host/port pair TCP
    // uses; parse it back out to form the informational authority and
    // the persisted `host:port` listen address. The bound host in the
    // hint already substitutes a routable address for a wildcard bind.
    const wsUrlHint = /** @type {string} */ (localHints['ws:url']);
    const wsUrl = new URL(wsUrlHint);
    const wsBoundPort = wsUrl.port;

    // Persist the resolved WS listen address (bind host + resolved
    // port) so an ephemeral port survives restart, mirroring the TCP
    // branch above.
    const resolvedWsHostPort = formatHostPort(
      /** @type {{ host: string }} */ (wsConfig).host,
      wsBoundPort,
    );
    if (resolvedWsHostPort !== wsConfig?.configured) {
      await E(powers).storeValue(resolvedWsHostPort, WS_LISTEN_ADDRESS_NAME);
    }

    addresses.push(
      `${wsProtocol}://${formatHostPort(wsUrl.hostname.replace(/^\[|\]$/g, ''), wsBoundPort)}/?node=${encodedNode}&loc=${encodedLocation}`,
    );
  }

  // `client.shutdown()` tears down the OCapN sessions and the
  // network's transports (closing the TCP and/or WebSocket listeners);
  // shutting the network down again separately would destroy sockets
  // out from under the in-flight session close.
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
      fromHex(binding.agentPublicKey),
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
        agentBindingMessage(sessionPublicKey),
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
    addresses: () => harden(addresses),
    /** @param {string} addressOrProtocol */
    supports: addressOrProtocol =>
      supports(addressOrProtocol, enabledProtocols),
    connect,
  });
};
harden(make);
