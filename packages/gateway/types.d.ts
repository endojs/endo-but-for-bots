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

/**
 * A daemon formula identifier. Content-addressed formulas (such as
 * a `readable-tree`) have an identifier that *is* their content
 * address, which is why the gateway can key its CAS cache on a
 * `contentRoot` directly.
 */
export type FormulaIdentifier = string;

/**
 * The daemon-side `weblet` formula the gateway resolves to serve a
 * virtual host (`designs/gateway-package.md` § Feature 2). The
 * gateway treats it as read-only data: a `contentRoot` to serve
 * statically, optional per-extension MIME overrides, an optional
 * SSR handler (wired in Feature 4 / Phase 2), and the optional set
 * of virtual-host names the weblet may bind.
 */
export type WebletFormula = {
  type: 'weblet';
  /**
   * Content tree to serve as static assets: a content-addressed
   * `readable-tree` per `designs/daemon-weblet-application.md`.
   */
  contentRoot: FormulaIdentifier;
  /**
   * Per-extension MIME-type overrides, keyed by lowercase extension
   * without a leading dot (e.g. `{ wasm: 'application/wasm' }`).
   */
  mimeTypes?: Record<string, string>;
  /**
   * SSR-route handler formula, invoked for requests that miss the
   * static content tree. Not wired in this Phase-1 increment.
   */
  ssrHandler?: FormulaIdentifier;
  /**
   * Virtual-host names this weblet may bind.
   */
  virtualHosts?: ReadonlyArray<string>;
};

/**
 * A single file in a content tree. The gateway needs only its
 * bytes; the daemon-side adapter assembles these from the
 * `readable-tree` leaf's `EndoReadable` (its `streamBase64()` /
 * `text()` surface).
 */
export type WebletReadable = {
  bytes(): Promise<Uint8Array>;
};

/**
 * The read-only subset of the daemon's `readable-tree` the gateway
 * consumes (`designs/daemon-weblet-application.md`): `has` and
 * `lookup` over a name or a multi-segment path. `lookup` returns a
 * {@link WebletReadable} for a file and a nested
 * {@link WebletContentTree} for a subdirectory.
 */
export type WebletContentTree = {
  has(nameOrPath: string | ReadonlyArray<string>): Promise<boolean>;
  lookup(
    nameOrPath: string | ReadonlyArray<string>,
  ): Promise<WebletReadable | WebletContentTree>;
};

/**
 * The powers-injected capability that lets the gateway resolve
 * weblet formulas and fetch their content trees without a live
 * daemon. The Phase-1 integration step adapts the daemon's formula
 * store and `readable-tree` to this shape; tests pass an in-memory
 * fake.
 */
export type GatewayContentResolver = {
  /**
   * Resolve a weblet formula identifier to its {@link WebletFormula}.
   */
  resolveWebletFormula(
    webletFormulaId: FormulaIdentifier,
  ): Promise<WebletFormula>;
  /**
   * Fetch the content tree (a `readable-tree`) named by a
   * content-address root. The gateway caches the result keyed by
   * the root, so this is called at most once per distinct root.
   */
  fetchContentTree(contentRoot: FormulaIdentifier): Promise<WebletContentTree>;
};

/**
 * The result of resolving and serving an inbound `(Host, path)`
 * request. A `200` carries the served bytes and the resolved MIME
 * type; a `404` distinguishes an unknown host, a missing file, and
 * an unsafe path; a `501` marks a static miss on an SSR-capable
 * weblet whose dynamic handler is not yet wired.
 */
export type ServeResult =
  | {
      status: 200;
      webletFormulaId: FormulaIdentifier;
      contentRoot: FormulaIdentifier;
      path: ReadonlyArray<string>;
      mimeType: string;
      bytes: Uint8Array;
    }
  | {
      status: 404;
      reason: 'unknown-host' | 'not-found' | 'invalid-path';
    }
  | {
      status: 501;
      reason: 'ssr-not-wired';
      ssrHandler: FormulaIdentifier;
    };

/**
 * The virtual-host weblet resolver / static server exo.
 */
export type WebletResolver = {
  serve(host: string, path: string): Promise<ServeResult>;
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
  /**
   * Feature 2: the formula-resolver / content-tree-reader capability
   * the virtual-host serving path uses. When supplied, the gateway
   * exposes a {@link WebletResolver} through `getWebletResolver()`;
   * when absent, the gateway runs the skeleton's routing-table-only
   * surface. Powers-injected so the path is testable without a live
   * daemon.
   */
  content?: GatewayContentResolver;
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
   * Feature 2: the virtual-host weblet resolver, present only when
   * `powers.content` was supplied. Resolves an inbound `(Host, path)`
   * to served bytes through the `@apps` table and the content
   * resolver. Returns `undefined` when no content resolver is wired.
   */
  getWebletResolver(): Promise<WebletResolver | undefined>;
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
export function makeWebletResolver(args: {
  apps: AppsNameHub;
  content: GatewayContentResolver;
}): WebletResolver;
export const DEFAULT_INDEX: string;
export const DEFAULT_CONTENT_TYPE: string;
export const DEFAULT_MIME_TYPES: Record<string, string>;
export function inferContentType(
  fileName: string,
  overrides?: Record<string, string>,
): string;
export function extensionOf(fileName: string): string;
export function normalizeRequestPath(path: string): string[] | undefined;
export function makeGateway(args?: {
  powers?: GatewayPowers;
  config?: Partial<GatewayConfig>;
}): Gateway;
