// Public type declarations for `@endo/gateway`.
//
// Every typedef the package exports lives here. Implementation modules
// import the types via `/** @import { Foo } from './types.js' */`
// (or, from `index.js`, via the package's `types` export).
//
// Byte fields use `Uint8Array` as the sole unit of transmission across
// the gateway's API (kriskowal directive, PR #393 review). Internal
// helpers may convert to an immutable `ArrayBuffer` when crossing the
// `@endo/marshal` boundary, but every developer-facing surface
// (arguments, return values, typedef fields) carries `Uint8Array`.

import type { Reader, Writer } from '@endo/stream';

// ---------------------------------------------------------------------
// config.js
// ---------------------------------------------------------------------

export type BindAddressKind = 'ipv4' | 'ipv6' | 'hostname';

export interface BindAddress {
  /** A non-empty hostname or IP literal, with no surrounding IPv6 brackets. */
  host: string;
  /** An integer in [0, 65535]. `0` means "let the OS choose". */
  port: number;
  /** The shape of `host`. Distinguishes `0.0.0.0` from `[::]` from `localhost`. */
  kind: BindAddressKind;
}

export interface FeatureToggles {
  /** Feature 1: Chat hosting + payment-token enhancement. */
  chatHosting: boolean;
  /** Feature 2: virtual hosting (Host header to Weblet formula). */
  virtualHosting: boolean;
  /** Feature 3: Git over HTTP, formula-identifier bearer-token. */
  gitHttp: boolean;
  /** Feature 4: sock bootstrap for local CapTP relay registration. */
  sockBootstrap: boolean;
  /** Feature 6: public CapTP relay (opt-in). */
  captpRelay: boolean;
  /** Feature 7: admin daemon (sock-only). */
  adminDaemon: boolean;
  /** Feature 8: `/ocapn-cbor-np` WebSocket subprotocol. */
  ocapnWebSocket: boolean;
}

export interface GatewayConfig {
  /** The `host:port` to bind, as accepted by `parseBindAddress`. */
  bindAddress: string;
  enableFeatures: FeatureToggles;
  /** Feature 9: CIDR ranges trusted to set `X-Forwarded-*` headers. */
  trustedProxyCidrs: ReadonlyArray<string>;
  /** Feature 9: maximum `X-Forwarded-For` hops to trust. */
  maxProxyHops: number;
}

// ---------------------------------------------------------------------
// vhost.js
// ---------------------------------------------------------------------

export interface VirtualHostEntry {
  /** The lowercased virtual-host name. */
  name: string;
  /**
   * The formula identifier the gateway should resolve when serving
   * this host. The current slice holds the identifier as an opaque
   * string; later phases replace it with a typed FormulaIdentifier.
   */
  webletFormulaId: string;
}

export interface AppsNameHub {
  /**
   * Bind a virtual host to a weblet formula. Throws on collision
   * with the design's first-bind-wins policy; later phases relax this
   * to operator policy.
   */
  bind(name: string, webletFormulaId: string): Promise<void>;
  unbind(name: string): Promise<void>;
  list(): Promise<ReadonlyArray<VirtualHostEntry>>;
  /** Throws if the name is not bound. */
  lookup(name: string): Promise<string>;
  has(name: string): Promise<boolean>;
}

// ---------------------------------------------------------------------
// proof-of-possession.js
// ---------------------------------------------------------------------

export interface CryptoPowers {
  /**
   * Returns a freshly-randomized `Uint8Array` of the requested
   * length. The byte source must be CSPRNG-quality (Node
   * `crypto.randomBytes`, libsodium `randombytes_buf`); a
   * non-cryptographic RNG breaks the security property.
   */
  randomBytes(byteLength: number): Uint8Array;
  /**
   * Returns the 32-byte SHA-256 hash of the input as a `Uint8Array`.
   * The bootstrap hashes the challenge nonce together with the
   * domain-separation prefix before storing or verifying.
   */
  sha256(input: Uint8Array): Uint8Array;
  /**
   * Returns `true` iff `signature` is a valid Ed25519 signature of
   * `message` under `publicKey`. Must not throw on malformed inputs;
   * returns `false` instead so the verifier upgrades to a uniform
   * reject path.
   */
  verifyEd25519(args: {
    publicKey: Uint8Array;
    message: Uint8Array;
    signature: Uint8Array;
  }): boolean;
}

export interface ClockPowers {
  /**
   * Returns the current time in milliseconds since the epoch.
   * Injected so tests can simulate nonce expiry deterministically.
   */
  now(): number;
}

export interface ChallengeIssued {
  /**
   * The unhashed nonce the registrar returns to the caller. The
   * caller will sign the *hashed* nonce.
   */
  nonce: Uint8Array;
  /**
   * The hashed bytes the caller must sign and the bootstrap stores
   * until the matching `register` call.
   */
  hashedNonce: Uint8Array;
  /** Epoch milliseconds. */
  issuedAt: number;
  /** `issuedAt + ttlMs`. */
  expiresAt: number;
}

export interface NonceRegistry {
  /** Mints a fresh nonce and stores its hash under the registry's TTL policy. */
  issue(): ChallengeIssued;
  /**
   * Verifies the proof-of-possession signature and consumes the
   * nonce. Throws on a malformed input, an unknown nonce, an expired
   * nonce, or a bad signature.
   */
  verifyAndConsume(args: {
    publicKey: Uint8Array;
    nonce: Uint8Array;
    signature: Uint8Array;
  }): void;
  /** Number of issued-but-unconsumed nonces currently held. */
  size(): number;
}

// ---------------------------------------------------------------------
// relay-policy.js
// ---------------------------------------------------------------------

/**
 * The two recognized policy values. `'closed'` requires the dialer's
 * public key to be in the registration's allowlist before the
 * gateway forwards the session; `'open'` accepts any dialer that the
 * gateway's outer filters (rate limits, CIDR allowlists) admit.
 */
export type RelayPolicy = 'closed' | 'open';

/**
 * Per-registration policy record. Stored on the bootstrap's
 * `RegistrationEntry` under a property named `policy`; the bootstrap
 * creates one of these on `registerRelay` and updates it via the
 * registrant-side and admin-side mutators.
 */
export interface RelayPolicyEntry {
  /** The current policy. Default is `'closed'`. */
  policy: RelayPolicy;
  /**
   * The set of dialer public keys (hex-encoded, lowercase, 64 chars
   * each) currently allowed to dial this relay under the closed
   * policy. Adding the same key twice is a no-op; removing a key
   * that is not in the set is also a no-op. The set is empty by
   * default; a closed-policy registration with an empty allowlist
   * accepts no dialers.
   */
  callerAllowlist: Set<string>;
}

/**
 * The shape passed to `isInboundSessionAllowed`. The handler injects
 * whatever it can read from the prefixed-SYN; under Noise IK today,
 * the dialer's public key is opaque so the field is `undefined`.
 */
export interface RelayAdmissionInput {
  /** The registration's policy record. */
  policy: RelayPolicyEntry;
  /**
   * The dialer's 32-byte Ed25519 public key when an
   * `extractDialerPublicKey` adapter supplied it, `undefined`
   * otherwise. `undefined` is the today-case under Noise IK; the
   * adapter is the future-extension hook for a pre-handshake
   * carrier of caller identity.
   */
  dialerPublicKey: Uint8Array | undefined;
}

export interface RelayAdmissionResult {
  allowed: boolean;
  reason: string;
}

// ---------------------------------------------------------------------
// bootstrap.js
// ---------------------------------------------------------------------

/**
 * The shape returned to a caller of `E(gatewayBootstrap).challenge()`.
 * The caller signs `hashedNonce` with its Ed25519 private key and
 * submits the resulting 64-byte signature as `proofOfPossession`
 * together with the *unhashed* `nonce`.
 */
export interface ChallengePayload {
  /** The 32-byte unhashed challenge. */
  nonce: Uint8Array;
  /** The 32-byte domain-separated hash that the caller signs. */
  hashedNonce: Uint8Array;
  /** Epoch milliseconds, for diagnostics. */
  issuedAt: number;
  /** Epoch milliseconds; after this, the nonce is rejected on submission. */
  expiresAt: number;
}

export interface WebletDescriptor {
  /**
   * Gateway-assigned identifier (the value the gateway routes by).
   * Allocated by the gateway and handed back to the registrant in a
   * parallel step the design names `allocateWebletId`; the current
   * slice treats it as an opaque caller-supplied string and the
   * allocator lands with feature-2's vhost-table integration.
   */
  webletId: string;
  /** SHA-256 hex of the readable-tree root the gateway should serve. */
  contentTreeRoot: string;
  /**
   * `true` if the weblet wants the gateway to forward upgrade
   * requests, `false` for static-only.
   */
  hasWebSocket: boolean;
}

/**
 * The shape passed to `Registration.addPublicKey`. Byte fields are
 * `Uint8Array`.
 */
export interface PublicKeyAddition {
  /** 32-byte raw Ed25519 public key. */
  publicKey: Uint8Array;
  /**
   * The unhashed nonce returned by a preceding `challenge()` call;
   * one nonce per public key.
   */
  nonce: Uint8Array;
  /** 64-byte Ed25519 signature of the hashed nonce under the new public key. */
  signature: Uint8Array;
}

/** Args to `GatewayBootstrap.register`. */
export interface RegistrationArgs {
  publicKey: Uint8Array;
  nonce: Uint8Array;
  /**
   * The proof-of-possession signature, as named `proofOfPossession`
   * in the design. The shorter wire name on the args object matches
   * OCapN's terse-message convention; the long name stays in the
   * prose.
   */
  signature: Uint8Array;
  /**
   * Optional user-daemon callback exo; when present, the gateway
   * later calls `handleHttp` / `handleWebSocketUpgrade` /
   * `fetchContentTree` on it for traffic destined to weblets this
   * registration publishes. Phase 2 stores the reference but does
   * not call into it; the call sites land with the HTTP/WS surface.
   */
  daemon?: unknown;
}

/** Args to `GatewayBootstrap.registerRelay`. */
export interface RelayRegistrationArgs {
  publicKey: Uint8Array;
  nonce: Uint8Array;
  signature: Uint8Array;
  /**
   * The relay-target handle the public CapTP relay (Feature 6)
   * forwards Noise-encrypted frames to. Phase 2 stores the
   * reference; Phase 5 consumes it as the forwarding target after
   * the relay-policy admission predicate passes.
   */
  relayTarget: unknown;
  /**
   * Optional per-registration policy override. Defaults to `'closed'`
   * (the design's "closed by default" framing). `'closed'` requires
   * the dialer's public key to be in the registration's caller
   * allowlist before the gateway forwards the session; `'open'`
   * accepts any dialer that the gateway's outer filters admit. The
   * closed-policy default yields a relay that drops every inbound
   * session until the registrant adds caller keys; open-policy
   * relays may be created with the same `register-relay` wire shape
   * by passing `relayPolicy: 'open'`.
   */
  relayPolicy?: RelayPolicy;
}

/**
 * Per-registration handle. Methods are `async` so they cross the
 * wire as eventual sends.
 */
export interface Registration {
  publishWeblet(descriptor: WebletDescriptor): Promise<void>;
  unpublishWeblet(webletId: string): Promise<void>;
  addPublicKey(addition: PublicKeyAddition): Promise<void>;
  deregister(): Promise<void>;
  listWeblets(): Promise<ReadonlyArray<WebletDescriptor>>;
  listPublicKeys(): Promise<ReadonlyArray<Uint8Array>>;
  /**
   * Update the relay policy on this registration. Returns the
   * previous policy. Throws when the registration is not a relay
   * registration (it was created with `register` rather than
   * `registerRelay`). Phase 5 (Feature 6).
   */
  setRelayPolicy(policy: RelayPolicy): Promise<RelayPolicy>;
  /** The current relay policy. Throws on a non-relay registration. */
  getRelayPolicy(): Promise<RelayPolicy>;
  /**
   * Add a dialer public key to the closed-policy allowlist. Returns
   * `true` if newly added, `false` if already present. Throws on a
   * non-relay registration.
   */
  addCallerPublicKey(callerPublicKey: Uint8Array): Promise<boolean>;
  /**
   * Remove a dialer public key from the closed-policy allowlist.
   * Returns `true` if removed, `false` if not present. Throws on a
   * non-relay registration.
   */
  removeCallerPublicKey(callerPublicKey: Uint8Array): Promise<boolean>;
  /**
   * Snapshot the closed-policy allowlist as lowercase-hex strings
   * (64 chars each), sorted. Throws on a non-relay registration.
   */
  listCallerPublicKeys(): Promise<ReadonlyArray<string>>;
}

/**
 * The bootstrap channel carries the registrar exo only: any local
 * user daemon that can connect to the bootstrap sock may register
 * itself, but **none** of these daemons have administrator authority.
 * The `GatewayAdmin` exo (Feature 7) is **not** reachable through
 * this bootstrap; it lives on a separate sock (`admin.sock`).
 */
export interface GatewayBootstrap {
  challenge(): Promise<ChallengePayload>;
  register(args: RegistrationArgs): Promise<Registration>;
  registerRelay(args: RelayRegistrationArgs): Promise<Registration>;
  getBindAddress(): Promise<string>;
  getApps(): Promise<AppsNameHub>;
}

// ---------------------------------------------------------------------
// admin.js
// ---------------------------------------------------------------------

/**
 * The shape `listRegistrations` returns per entry. Byte fields are
 * returned as `Uint8Array`; the caller can hex-render them with the
 * same helper the bootstrap uses internally.
 */
export interface RegistrationSummary {
  /**
   * Every public key bound to this registration. The first key is
   * the one passed to `register` / `registerRelay`; subsequent keys
   * come from `addPublicKey`.
   */
  publicKeys: ReadonlyArray<Uint8Array>;
  /** All weblets the registration has published and not unpublished. */
  weblets: ReadonlyArray<WebletDescriptor>;
  /**
   * Present when the registration came in through `registerRelay`;
   * the relay target exo for Feature 6.
   */
  relayTarget?: unknown;
  /**
   * Present when the registration came in through `register`; the
   * user-daemon callback exo for the HTTP / WS surface (Feature 4
   * follow-on).
   */
  daemon?: unknown;
  /** Present for relay registrations (Phase 5). The current policy value. */
  relayPolicy?: RelayPolicy;
  /**
   * Present for relay registrations (Phase 5). The set of dialer
   * public keys currently allowed to dial this relay under the
   * closed policy, rendered as lowercase hex (64 chars each), sorted.
   */
  callerAllowlist?: ReadonlyArray<string>;
}

export interface VirtualHostSummary {
  /** The lowercased virtual-host name. */
  name: string;
  /** The bound weblet formula identifier. */
  webletFormulaId: string;
}

export interface ResourceBalance {
  /**
   * Account identifier (per-user-daemon handle, opaque to the
   * gateway today).
   */
  account: string;
  /** Compute-time tokens (suggested unit: seconds). */
  compute: number;
  /** Storage tokens (suggested unit: bytes). */
  storage: number;
  /** Network tokens (suggested unit: bytes). */
  network: number;
}

/**
 * The Feature 1 surface the administrator queries. Phase 3 ships the
 * admin facet that *calls* into the ledger; the ledger
 * implementation itself lands with the Chat-hosting feature. Until
 * then, embedders that want admin reads of resource balances supply
 * a stub.
 */
export interface ResourceLedger {
  listBalances(): Promise<ReadonlyArray<ResourceBalance>>;
}

/**
 * Per-registration counters the administrator dumps for diagnostics.
 * The shape is intentionally open: future phases extend it with
 * HTTP / WS / OCapN counters without changing the call site. The
 * current slice surfaces what Phase 2 actually counts: the size of
 * the registration table and the number of outstanding nonces.
 */
export interface CountersSnapshot {
  totalRegistrations: number;
  /** Aggregate count across every registration. */
  totalWeblets: number;
  /** Outstanding (issued, not yet consumed or expired) challenges. */
  pendingNonces: number;
}

/** CapTP-facing exo. All methods are `async` so they cross the wire as eventual sends. */
export interface GatewayAdmin {
  /** Returns every non-deregistered entry in the registration table. */
  listRegistrations(): Promise<ReadonlyArray<RegistrationSummary>>;
  /**
   * Force-deregister the registration that owns the supplied public
   * key. Returns `true` if a matching registration was found and
   * torn down, `false` if no registration claimed the key. A
   * registration is identified by *any* of its public keys; the
   * whole registration tombstones.
   */
  deregisterRelay(publicKey: Uint8Array): Promise<boolean>;
  /**
   * Snapshot the `@apps` NameHub. Reads only; admin does not
   * override the routing policy from this method.
   */
  listVirtualHosts(): Promise<ReadonlyArray<VirtualHostSummary>>;
  /**
   * Snapshot the resource ledger. Returns an empty list when no
   * `ResourceLedger` is wired (Phase 3 ships this stubbed; Feature
   * 1 wires the ledger in).
   */
  getResourceBalances(): Promise<ReadonlyArray<ResourceBalance>>;
  /** Diagnostic counter dump. */
  getCounters(): Promise<CountersSnapshot>;
  /**
   * Set the relay policy on the matched relay registration. Returns
   * the previous policy value. Throws when no live registration
   * claims the key, or when the matching registration is not a
   * relay registration.
   */
  setRelayPolicy(
    publicKey: Uint8Array,
    policy: RelayPolicy,
  ): Promise<RelayPolicy>;
  /**
   * Add a dialer public key to the closed-policy allowlist on the
   * matched relay registration. Returns `true` when newly added,
   * `false` when already present. Throws when no live registration
   * claims the key, or on a non-relay registration.
   */
  addRelayCaller(
    publicKey: Uint8Array,
    callerPublicKey: Uint8Array,
  ): Promise<boolean>;
  /**
   * Remove a dialer public key from the closed-policy allowlist on
   * the matched relay registration. Returns `true` when removed,
   * `false` when not in the allowlist. Throws when no live
   * registration claims the key, or on a non-relay registration.
   */
  removeRelayCaller(
    publicKey: Uint8Array,
    callerPublicKey: Uint8Array,
  ): Promise<boolean>;
}

/**
 * The in-process interface the bootstrap exposes to the admin facet.
 * Keeps the admin exo loosely coupled to the bootstrap's internal
 * representation; the bootstrap returns this shape from
 * `makeGatewayBootstrap`'s second return value, and `makeGatewayAdmin`
 * consumes it.
 */
export interface AdminBackplane {
  /** In-process snapshot of every live registration. */
  listRegisteredPeers(): ReadonlyArray<RegistrationSummary>;
  /**
   * Synchronous force-deregister hook. Returns `true` if a matching
   * registration was torn down.
   */
  deregisterByPublicKey(publicKey: Uint8Array): boolean;
  /**
   * Set the relay policy on the matched relay registration. Returns
   * the previous policy when found, `undefined` when no live
   * registration claims the key; throws when the matching
   * registration is not a relay registration.
   */
  setRelayPolicyByPublicKey(
    publicKey: Uint8Array,
    policy: RelayPolicy,
  ): RelayPolicy | undefined;
  /**
   * Add a dialer public key to the closed-policy allowlist on the
   * matched relay registration. Returns `true` when newly added,
   * `false` when already present, `undefined` when no live
   * registration claims the key; throws on a non-relay registration.
   */
  addRelayCallerByPublicKey(
    publicKey: Uint8Array,
    callerPublicKey: Uint8Array,
  ): boolean | undefined;
  /**
   * Remove a dialer public key from the closed-policy allowlist on
   * the matched relay registration. Returns `true` when removed,
   * `false` when not in the allowlist, `undefined` when no live
   * registration claims the key; throws on a non-relay registration.
   */
  removeRelayCallerByPublicKey(
    publicKey: Uint8Array,
    callerPublicKey: Uint8Array,
  ): boolean | undefined;
  /** Count of outstanding challenges. */
  pendingNonces(): number;
}

// ---------------------------------------------------------------------
// ocapn-ws.js
// ---------------------------------------------------------------------

/**
 * The per-connection byte-stream pair the embedder hands to
 * `handleConnection`. Each binary WebSocket frame becomes one
 * `Uint8Array` chunk (per the design's *Framing* paragraph: one
 * Noise message per WebSocket binary frame). The gateway does not
 * concatenate or split frames; the embedder's WS adapter preserves
 * message boundaries.
 */
export interface OcapnByteStream {
  reader: Reader<Uint8Array>;
  writer: Writer<Uint8Array>;
}

/**
 * The shape the gateway hands off to the registered daemon (or relay
 * target) after looking up the registration by intended-responder
 * public key. The two stream halves are independent: the `reader`
 * yields incoming frames from the dialing peer (with the first frame
 * replayed, prefix included), and the `writer` accepts outgoing
 * frames to send back. The gateway does not inspect either side
 * after the handoff.
 */
export interface OcapnSessionTarget {
  reader: Reader<Uint8Array>;
  writer: Writer<Uint8Array>;
}

/**
 * The remote-exo contract the gateway calls into. The registered
 * daemon (or relay target) implements `handleOcapnSession`; the
 * gateway forwards the per-connection stream pair and the registered
 * daemon runs its own Noise responder over those bytes.
 *
 * The method returns once the daemon has accepted ownership of the
 * stream pair; the daemon's own background task pumps bytes
 * thereafter. The gateway does not await the session's completion
 * (that would require holding the eventual-send promise open for the
 * lifetime of the WS connection, which is open-ended).
 */
export interface OcapnSessionHandler {
  handleOcapnSession(target: OcapnSessionTarget): Promise<void>;
}

/**
 * The shape `lookupRegistrationByPublicKey` returns when a live
 * registration claims the queried public key. Either `daemon` or
 * `relayTarget` may be set. Both are typed as `unknown` here because
 * the gateway treats them as opaque exo handles: the only call site
 * is `E(target).handleOcapnSession({ reader, writer })`.
 *
 * For relay registrations the lookup also returns the live `policy`
 * entry. The handler consults the policy before handing off; for
 * `register` (non-relay) registrations the field is `undefined` and
 * the handler forwards unconditionally (the registration itself is
 * the authorization).
 */
export interface RegistrationLookupResult {
  daemon?: unknown;
  relayTarget?: unknown;
  policy?: RelayPolicyEntry;
}

/**
 * The optional adapter that reads the dialer's 32-byte Ed25519
 * public key out of the prefixed-SYN. Today's OCapN-Noise wire shape
 * uses Noise IK, which encrypts the initiator's static under the
 * responder's static (Noise §7.8 property 8, identity hiding); under
 * that wire shape the adapter returns `undefined` and `closed`-policy
 * relay registrations fail closed. A future Noise variant or
 * pre-handshake protocol extension that carries a cleartext
 * caller-identity hint plugs in here without reworking the handler.
 */
export type ExtractDialerPublicKey = (
  firstFrame: Uint8Array,
) => Uint8Array | undefined;

/** CapTP-facing exo. The single method is `async` so it crosses the wire as an eventual send. */
export interface OcapnWebSocketHandler {
  /**
   * Accept an upgraded WebSocket connection as a `{ reader, writer }`
   * pair, route to the registered daemon by the intended-responder
   * prefix on the first frame, or close the connection on
   * protocol-level failure (missing first frame, frame too short,
   * no registration claims the public key, registered exo throws).
   *
   * Resolves once the dispatching step completes (registration
   * lookup + handoff to the daemon's `handleOcapnSession`); does not
   * wait for the WS session itself to drain.
   */
  handleConnection(stream: OcapnByteStream): Promise<void>;
}

// ---------------------------------------------------------------------
// sock-paths.js
// ---------------------------------------------------------------------

export interface SocketPathInfo {
  /** Home directory for fallback resolution. */
  home: string;
  /** User name for fallback resolution. */
  user: string;
  /** Temp directory for fallback resolution. */
  temp: string;
}

export type SocketPathSource =
  | 'override'
  | 'system'
  | 'user-xdg'
  | 'user-darwin'
  | 'user-tmpdir';

export interface SocketPathResolution {
  /** The resolved sock path. */
  path: string;
  /**
   * Where the path came from. Useful for diagnostics: when an
   * operator misconfigures the override, the source name in the
   * warning tells them which rule they hit.
   */
  source: SocketPathSource;
  /**
   * The listener shape. Always a UNIX domain socket; the gateway
   * targets Linux primarily and macOS secondarily, both of which use
   * a UNIX domain socket for the sock.
   */
  kind: 'unix-socket';
}

/**
 * Alias for backwards-compatibility with the phase-2 typedef names.
 * New code should use the `Socket`-prefixed names.
 */
export type BootstrapPathInfo = SocketPathInfo;

export type BootstrapPathResolution = SocketPathResolution;

// ---------------------------------------------------------------------
// index.js
// ---------------------------------------------------------------------

/**
 * The host-supplied powers the gateway needs to listen on the
 * network and read the environment. The phase-1 skeleton uses only
 * `env`; phase 2 adds `crypto` and `clock` for the bootstrap
 * registrar; later phases add `net` and `fs`.
 */
export interface GatewayPowers {
  env?: { [name: string]: string | undefined };
  /**
   * Required when `sockBootstrap` is enabled. The bootstrap
   * registrar needs `randomBytes`, `sha256`, and `verifyEd25519`.
   */
  crypto?: CryptoPowers;
  /**
   * Required when `sockBootstrap` is enabled. The nonce registry
   * consumes `now()` for TTL.
   */
  clock?: ClockPowers;
  /**
   * Optional Feature 1 resource ledger. When `adminDaemon` is on
   * and a ledger is supplied, `GatewayAdmin.getResourceBalances`
   * reads through this. When omitted, the admin facet still works
   * but `getResourceBalances` returns an empty list. Feature 1's
   * ledger implementation lands with the Chat-hosting phase; until
   * then, embedders that want admin reads supply a stub.
   */
  resourceLedger?: ResourceLedger;
  /**
   * Required when `gitHttp` is enabled. The bearer-token resolver
   * the Git smart-HTTP handler calls per request. Resolves the
   * bearer formula identifier to a {@link DaemonRepoCapability}
   * scoped to that formula's ref within the daemon's one Git object
   * store. Until the daemon-side wiring lands, tests inject a stub
   * resolver and embedders that want git off entirely set
   * `enableFeatures.gitHttp = false`.
   */
  serveRepo?: ServeRepo;
}

export interface Gateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * The address the gateway is bound to, in `host:port` form.
   * Before `start()`, the configured value; after `start()`, the
   * resolved address (which differs from the configured value when
   * the configured port is `0`).
   */
  getBindAddress(): Promise<string>;
  getApps(): Promise<AppsNameHub>;
  getConfig(): Promise<GatewayConfig>;
  /**
   * Throws when `sockBootstrap` is disabled in the gateway's
   * feature toggles. The returned exo is also the entry capability
   * a sock listener serves to incoming CapTP connections; a process
   * embedding the gateway in-realm calls `getBootstrap` directly.
   */
  getBootstrap(): Promise<GatewayBootstrap>;
  /**
   * Returns the `GatewayAdmin` exo (Feature 7). Throws when the
   * `adminDaemon` feature toggle is off. The admin facet is
   * **never** served on the gateway's public HTTP / WS surface, and
   * is **never** reached through the bootstrap sock; it is
   * reachable only in-process (this method) and over a separate
   * admin sock (`admin.sock`) whose listener lands in a follow-on
   * PR alongside the bootstrap sock's listener.
   */
  getAdmin(): Promise<GatewayAdmin>;
  /**
   * Returns the `OcapnWebSocketHandler` exo (Feature 8) that an
   * embedder feeds upgraded `/ocapn-cbor-np` WebSocket connections
   * to. Throws when the `ocapnWebSocket` feature toggle is off, or
   * when `sockBootstrap` is off (the handler depends on the
   * registration table the bootstrap owns; without it there is no
   * daemon to forward to). The HTTP listener that performs the WS
   * upgrade is the embedder's, not the gateway's.
   */
  getOcapnHandler(): Promise<OcapnWebSocketHandler>;
  /**
   * Returns the `GitHttpHandler` exo (Feature 3) that an embedder
   * feeds `/git/...` HTTP requests to. Throws when the `gitHttp`
   * feature toggle is off; the HTTP listener that routes `/git/`
   * requests to the handler is the embedder's, not the gateway's.
   *
   * The daemon embedding the gateway hosts one Git object store and
   * serves content for the formula named by the bearer token; the
   * URL path has no repository segment.
   */
  getGitHttpHandler(): Promise<GitHttpHandler>;
}

// ---------------------------------------------------------------------
// git-http.js
// ---------------------------------------------------------------------

/**
 * The two smart-HTTP service names. `git-upload-pack` is the fetch /
 * clone direction (server-to-client); `git-receive-pack` is the push
 * direction (client-to-server).
 */
export type GitService = 'git-upload-pack' | 'git-receive-pack';

/**
 * The three smart-HTTP operations the handler routes. `info/refs` is
 * the GET advertisement that announces the service's capabilities
 * and refs; the other two are POST data exchanges.
 */
export type GitOperation = 'info/refs' | 'git-upload-pack' | 'git-receive-pack';

/**
 * The per-request shape the embedder hands the handler. Mirrors a
 * conventional Node `http.IncomingMessage` slice: the parsed HTTP
 * method, the URL path, the optional query string (no leading `?`),
 * the header pairs, and the request body bytes.
 */
export interface GitHttpRequest {
  method: string;
  /** URL path (no query string, no host). */
  path: string;
  /** URL query string with no leading `?`. May be the empty string. */
  query?: string;
  headers: ReadonlyArray<readonly [string, string]>;
  /**
   * The request body bytes as a `Uint8Array`. Empty bodies are
   * zero-byte `Uint8Array`s. The handler forwards the body to the
   * repo capability without parsing the Git protocol.
   */
  body: Uint8Array;
}

/** The per-response shape the handler returns. */
export interface GitHttpResponse {
  status: number;
  headers: ReadonlyArray<readonly [string, string]>;
  /**
   * The response body bytes as a `Uint8Array`. Empty bodies are
   * zero-byte `Uint8Array`s.
   */
  body: Uint8Array;
}

/** Args to the embedder-supplied `serveRepo` adapter. */
export interface ServeRepoArgs {
  /**
   * The bearer token extracted from the Authorization header. A
   * formula identifier per `daemon-256-bit-identifiers.md`: 64
   * lowercase hex characters, optionally followed by `:<node>`.
   */
  token: string;
}

/**
 * The exo the adapter returns from `serveRepo`. Two POST methods
 * for the two smart-HTTP services, and an `infoRefs` method for the
 * GET advertisement. The methods are independent: a daemon repo
 * capability that omits one of them will surface that omission as a
 * runtime error from the gateway.
 *
 * The capability is scoped to a single formula's ref within the
 * daemon's one Git object store; the methods do not take a repo-id
 * argument because the daemon hosts exactly one repository for
 * content served on virtual hosts and the bearer-resolved formula
 * already names the ref (typically `refs/formulas/<formula-id>`).
 * A formula GC that drops the formula deletes the matching ref;
 * the next `git gc` collects the orphan objects.
 */
export interface DaemonRepoCapability {
  /**
   * Serve the `info/refs?service=<service>` GET advertisement as the
   * response body.
   */
  infoRefs(args: {
    service: GitService;
    headers: ReadonlyArray<readonly [string, string]>;
  }): Promise<GitHttpResponse>;
  /**
   * Serve the `git-upload-pack` POST: the request body carries the
   * client's want/have negotiation; the response body carries the
   * packfile.
   */
  gitUploadPack(args: {
    requestBody: Uint8Array;
    headers: ReadonlyArray<readonly [string, string]>;
  }): Promise<GitHttpResponse>;
  /**
   * Serve the `git-receive-pack` POST: the request body carries the
   * packfile; the response body carries the per-ref status.
   */
  gitReceivePack(args: {
    requestBody: Uint8Array;
    headers: ReadonlyArray<readonly [string, string]>;
  }): Promise<GitHttpResponse>;
}

/**
 * The bearer-token resolver the Git smart-HTTP handler calls per
 * request. Returns the daemon repo capability when the bearer token
 * authorizes access to a live formula, or `undefined` to map to a
 * 401 response (the gateway does not distinguish "wrong token" from
 * "no such formula" so a probing attacker cannot enumerate the
 * formula namespace).
 */
export type ServeRepo = (
  args: ServeRepoArgs,
) => Promise<DaemonRepoCapability | undefined>;

/** CapTP-facing exo. The single method is `async`. */
export interface GitHttpHandler {
  /**
   * Handle one HTTP request. Returns the response shape the embedder
   * forwards to its HTTP server. The handler never throws; every
   * error path maps to a `GitHttpResponse` with a status code.
   */
  handleRequest(request: GitHttpRequest): Promise<GitHttpResponse>;
}

export declare const DEFAULT_BIND_ADDRESS: string;
export declare const defaultFeatureToggles: FeatureToggles;
export declare const defaultGatewayConfig: GatewayConfig;

export declare function parseBindAddress(input: string): BindAddress;
export declare function mergeGatewayConfig(
  config?: Partial<GatewayConfig>,
): GatewayConfig;
export declare function bindAddressFromEnv(
  env: { [name: string]: string | undefined },
  configured?: string,
): string;
export declare function normalizeVirtualHostName(name: string): string;
export declare function makeAppsNameHub(): AppsNameHub;
export declare function makeGateway(args?: {
  powers?: GatewayPowers;
  config?: Partial<GatewayConfig>;
}): Gateway;
