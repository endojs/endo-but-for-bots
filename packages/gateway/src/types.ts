export type CryptoPowers = {
  randomBytes(byteLength: number): ArrayBuffer;
  sha256(input: ArrayBuffer | Uint8Array): ArrayBuffer;
  verifyEd25519(args: {
    publicKey: ArrayBuffer | Uint8Array;
    message: ArrayBuffer | Uint8Array;
    signature: ArrayBuffer | Uint8Array;
  }): boolean;
};

export type ClockPowers = { now(): number };

export type ChallengeIssued = {
  nonce: ArrayBuffer;
  hashedNonce: ArrayBuffer;
  issuedAt: number;
  expiresAt: number;
};

export type NonceRegistry = {
  issue(): ChallengeIssued;
  verifyAndConsume(args: {
    publicKey: ArrayBuffer | Uint8Array;
    nonce: ArrayBuffer | Uint8Array;
    signature: ArrayBuffer | Uint8Array;
  }): void;
  size(): number;
};

export type ChallengePayload = ChallengeIssued;

export type WebletDescriptor = {
  webletId: string;
  contentTreeRoot: string;
  hasWebSocket: boolean;
};

export type PublicKeyAddition = {
  publicKey: ArrayBuffer | Uint8Array;
  nonce: ArrayBuffer | Uint8Array;
  signature: ArrayBuffer | Uint8Array;
};

export type RegistrationArgs = PublicKeyAddition & {
  daemon?: unknown;
  cancelled?: Promise<unknown>;
};

export type RelayRegistrationArgs = PublicKeyAddition & {
  relayTarget: unknown;
};

export type RegistrationEntry = {
  publicKeys: ReadonlyArray<ArrayBuffer | Uint8Array>;
  daemon: unknown;
  weblets: Map<string, WebletDescriptor>;
  deregistered: boolean;
};

export type Registration = {
  publishWeblet(descriptor: WebletDescriptor): Promise<void>;
  unpublishWeblet(webletId: string): Promise<void>;
  addPublicKey(addition: PublicKeyAddition): Promise<void>;
  deregister(): Promise<void>;
  listWeblets(): Promise<ReadonlyArray<WebletDescriptor>>;
  listPublicKeys(): Promise<ReadonlyArray<ArrayBuffer | Uint8Array>>;
};

export type GatewayBootstrap = {
  challenge(): Promise<ChallengePayload>;
  register(args: RegistrationArgs): Promise<Registration>;
  registerRelay(args: RelayRegistrationArgs): Promise<Registration>;
  getBindAddress(): Promise<string>;
  getApps(): Promise<AppsNameHub>;
};

export type BootstrapDeps = {
  crypto: CryptoPowers;
  clock: ClockPowers;
  apps: AppsNameHub;
  getBindAddress(): string;
  ttlMs?: number;
};

export type BootstrapPathInfo = {
  home: string;
  user: string;
  temp: string;
};

export type BootstrapPathResolution = {
  path: string;
  source:
    | 'override'
    | 'system'
    | 'user-xdg'
    | 'user-darwin'
    | 'user-tmpdir';
  kind: 'unix-socket';
};

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
