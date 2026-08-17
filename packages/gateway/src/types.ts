import type { CryptoPowers, ClockPowers } from './proof-of-possession.js';
import type { GatewayBootstrap } from './bootstrap.js';
import type { GatewayAdmin, ResourceLedger } from './admin.js';
import type { OcapnWebSocketHandler } from './ocapn-ws.js';

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
  sockBootstrap: boolean;
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
   * later phases add `net` and `fs`.
   */
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
  /**
   * Throws when `sockBootstrap` is disabled in the gateway's
   * feature toggles. The returned exo is also the entry capability
   * a sock listener serves to incoming CapTP connections; a
   * process embedding the gateway in-realm calls `getBootstrap`
   * directly.
   */
  getBootstrap(): Promise<GatewayBootstrap>;
  /**
   * Returns the `GatewayAdmin` exo (Feature 7). Throws when the
   * `adminDaemon` feature toggle is off. The admin facet is
   * **never** served on the gateway's public HTTP / WS surface,
   * and is **never** reached through the bootstrap sock; it is
   * reachable only in-process (this method) and over a separate
   * admin sock (`admin.sock`) whose listener lands in a follow-on
   * PR alongside the bootstrap sock's listener. The two socks are
   * distinct file paths and the admin sock's deployment is
   * responsible for placing it under a non-world-traversable
   * parent directory so only the administrator OS account can
   * `connect(2)`.
   */
  getAdmin(): Promise<GatewayAdmin>;
  /**
   * Returns the `OcapnWebSocketHandler` exo (Feature 8) that an
   * embedder feeds upgraded `/ocapn-cbor-np` WebSocket connections
   * to. The exo's `handleConnection({ reader, writer })` reads the
   * first frame's intended-responder prefix, looks up the
   * registration that owns the key (via the bootstrap registrar's
   * table), and hands the stream pair off to the registered
   * daemon's `handleOcapnSession`. Throws when the `ocapnWebSocket`
   * feature toggle is off, or when `sockBootstrap` is off (the
   * handler depends on the registration table the bootstrap owns;
   * without it there is no daemon to forward to). The HTTP listener
   * that performs the WS upgrade is the embedder's, not the
   * gateway's; see `src/ocapn-ws.js` for the contract.
   */
  getOcapnHandler(): Promise<OcapnWebSocketHandler>;
};

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
