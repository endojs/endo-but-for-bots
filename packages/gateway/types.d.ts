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

export type GatewayPowers = {
  /**
   * Environment-shaped map. The phase-1 skeleton uses only `env`;
   * later phases add `net`, `fs`, `crypto`, and `time`.
   */
  env?: { [name: string]: string | undefined };
};

export type OcapnWebSocketRoute = {
  /**
   * The bare request path that matched (query, fragment, and a
   * trailing slash removed).
   */
  requestedPath: string;
  /**
   * The canonical `/ocapn-<codec>-<network>` path. Equals
   * `requestedPath` except when `isAlias` is `true`, where the legacy
   * `/ocapn` resolves to `/ocapn-cbor-np`.
   */
  canonicalPath: string;
  /**
   * The OCapN protocol family (always `'ocapn'`).
   */
  protocol: string;
  /**
   * The payload codec the path names (`'cbor'` for the canonical
   * path).
   */
  codec: string;
  /**
   * The network identifier the path names (`'np'` for the canonical
   * path).
   */
  network: string;
  /**
   * `true` when the legacy `/ocapn` alias matched.
   */
  isAlias: boolean;
  /**
   * `true` when this gateway serves the path's codec/network pair;
   * `false` for a recognized-but-reserved sibling.
   */
  isSupported: boolean;
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

export const OCAPN_PROTOCOL_FAMILY: string;
export const OCAPN_WS_CODEC: string;
export const OCAPN_WS_NETWORK: string;
export const OCAPN_WS_PATH: string;
export const OCAPN_WS_LEGACY_ALIAS_PATH: string;
export const OCAPN_WS_SUPPORTED: ReadonlyArray<{
  codec: string;
  network: string;
}>;
export function matchOcapnWebSocketPath(
  rawPath: string,
): OcapnWebSocketRoute | undefined;
export function parseOcapnWebSocketPath(rawPath: string): OcapnWebSocketRoute;
export function ocapnWebSocketConnectionHint(args: {
  host: string;
  secure?: boolean;
}): string;
export function makeGateway(args?: {
  powers?: GatewayPowers;
  config?: Partial<GatewayConfig>;
}): Gateway;
