import type { Reader, Writer } from '@endo/stream';

export type BindAddress = {
  /**
   * A non-empty hostname or IP literal, with no surrounding IPv6
   * brackets.
   */
  host: string;
  /**
   * An integer in [0, 65535]. `0` means "let the OS choose".
   */
  port: number;
  /**
   * The shape of `host`. Distinguishes `0.0.0.0` from `[::]`
   * from `localhost`.
   */
  kind: 'ipv4' | 'ipv6' | 'hostname';
};

export type FeatureToggles = {
  chatHosting: boolean;
  virtualHosting: boolean;
  gitHttp: boolean;
  udsBootstrap: boolean;
  captpRelay: boolean;
  adminDaemon: boolean;
  ocapnWebSocket: boolean;
};

export type GatewayConfig = {
  /**
   * The `host:port` to bind, as accepted by `parseBindAddress`.
   */
  bindAddress: string;
  enableFeatures: FeatureToggles;
  /**
   * Feature 9: CIDR ranges trusted to set `X-Forwarded-*` headers.
   */
  trustedProxyCidrs: ReadonlyArray<string>;
  /**
   * Feature 9: maximum `X-Forwarded-For` hops to trust.
   */
  maxProxyHops: number;
};

export type VirtualHostEntry = {
  /**
   * The lowercased virtual-host name.
   */
  name: string;
  /**
   * The formula identifier the gateway should resolve when serving
   * this host.
   */
  webletFormulaId: string;
};

export type AppsNameHub = {
  /**
   * Bind a virtual host to a weblet formula.
   */
  bind(name: string, webletFormulaId: string): Promise<void>;
  unbind(name: string): Promise<void>;
  list(): Promise<ReadonlyArray<VirtualHostEntry>>;
  /**
   * Throws if the name is not bound.
   */
  lookup(name: string): Promise<string>;
  has(name: string): Promise<boolean>;
};

/**
 * A `WebSocket`-shaped object: the subset the OCapN endpoint adapter
 * touches. Satisfied by the browser `WebSocket` and a Node `ws`
 * instance (which implements the same `on*` property setters). The
 * adapter drives binary messages only.
 */
export type WebSocketLike = {
  binaryType?: string;
  send(data: Uint8Array): void;
  close(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

/**
 * A bidirectional byte stream: one binary WebSocket message per
 * `Uint8Array` chunk. The netlayer supplies its own Noise framing.
 */
export type ByteStream = {
  reader: Reader<Uint8Array>;
  writer: Writer<Uint8Array>;
};

/**
 * The resolved classification of a request path against the OCapN
 * endpoint (Feature 8).
 */
export type OcapnPathMatch = {
  /** The canonical `/ocapn-cbor-np` path this match resolves to. */
  canonicalPath: string;
  /** The path the client actually requested. */
  requestedPath: string;
  /**
   * True when the client used the bare `/ocapn` compatibility
   * alias rather than the canonical path.
   */
  viaAlias: boolean;
};

/**
 * Per-connection metadata handed to the connection sink alongside
 * the framed byte-stream.
 */
export type OcapnConnectionMeta = OcapnPathMatch;

/**
 * The netlayer sink: called with the framed byte-stream for each
 * accepted OCapN WebSocket upgrade. Matches the OCapN-Noise
 * transport `listen` handler contract (`(connection) => void`); the
 * gateway adds the `meta` argument for routing/telemetry.
 */
export type OcapnConnectionHandler = (
  connection: ByteStream,
  meta: OcapnConnectionMeta,
) => void;

/**
 * The gateway's OCapN WebSocket endpoint. A host's HTTP upgrade
 * router consults `matchPath` to decide whether an upgrade is the
 * OCapN endpoint and calls `accept` to hand a matched socket to the
 * embedded transport.
 */
export type OcapnWebSocketEndpoint = {
  /** The canonical OCapN path, `/ocapn-cbor-np`. */
  canonicalPath: string;
  /** The compatibility alias, `/ocapn`. */
  aliasPath: string;
  /** Both recognized paths, canonical first. */
  paths: ReadonlyArray<string>;
  matchPath(pathname: string): OcapnPathMatch | null;
  /**
   * Adapt a matched WebSocket upgrade to a byte-stream and hand it
   * to the injected sink. Throws when `pathname` is not an OCapN
   * endpoint path.
   */
  accept(pathname: string, ws: WebSocketLike): void;
};

/**
 * The OCapN seam (Feature 8). The daemon integration injects the
 * netlayer sink here; wiring it to `@endo/ocapn-noise` and the
 * `@apps` NameHub is the deferred named seam.
 */
export type OcapnPowers = {
  /**
   * The netlayer sink for accepted OCapN WebSocket connections.
   * When the OCapN feature is enabled and no sink is injected, a
   * stray `/ocapn` upgrade fails loudly rather than being dropped.
   */
  onConnection?: OcapnConnectionHandler;
  /**
   * Optional receiver for the constructed endpoint. The gateway
   * calls it once, at construction, when the OCapN feature is
   * enabled — the embedder's HTTP upgrade router uses the endpoint
   * to route `/ocapn*` upgrades.
   */
  register?: (endpoint: OcapnWebSocketEndpoint) => void;
};

export type GatewayPowers = {
  /**
   * Environment-shaped map. The phase-1 skeleton uses only `env`;
   * later phases add `net`, `fs`, `crypto`, and `time`.
   */
  env?: { [name: string]: string | undefined };
  /**
   * Feature 8 seam: the OCapN-over-WebSocket netlayer sink and the
   * optional endpoint receiver.
   */
  ocapn?: OcapnPowers;
};

export type Gateway = {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * The address the gateway is bound to, in `host:port` form.
   * Before `start()`, the configured value; after `start()`, the
   * resolved address.
   */
  getBindAddress(): Promise<string>;
  getApps(): Promise<AppsNameHub>;
  getConfig(): Promise<GatewayConfig>;
};

export const DEFAULT_BIND_ADDRESS: string;
export const defaultFeatureToggles: FeatureToggles;
export const defaultGatewayConfig: GatewayConfig;

export function parseBindAddress(input: string): BindAddress;
export function mergeGatewayConfig(
  config?: Partial<GatewayConfig>,
): GatewayConfig;
export function bindAddressFromEnv(
  env: { [name: string]: string | undefined },
  configured?: string,
): string;
export function normalizeVirtualHostName(name: string): string;
export function makeAppsNameHub(): AppsNameHub;

export const OCAPN_CANONICAL_PATH: string;
export const OCAPN_COMPAT_PATH: string;
export function matchOcapnPath(pathname: string): OcapnPathMatch | null;
export function adaptWebSocket(ws: WebSocketLike): ByteStream;
export function makeOcapnWebSocketEndpoint(args?: {
  onConnection?: OcapnConnectionHandler;
}): OcapnWebSocketEndpoint;
export function makeGateway(args?: {
  powers?: GatewayPowers;
  config?: Partial<GatewayConfig>;
}): Gateway;
