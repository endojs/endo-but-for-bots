import type {
  FetchLike,
  HttpClient,
  HttpClientControl,
  PolicyAuthority,
  PolicyMode,
} from '@endo/exo-http-client';

export type FetchStoreDirectory = {
  lookup: (name: string) => Promise<FetchStoreFile> | FetchStoreFile;
  write: (name: string, content: string) => Promise<void> | void;
  move: (from: string, to: string) => Promise<void> | void;
};

export type FetchStoreFile = {
  snapshot: () => Promise<FetchStoreSnapshot> | FetchStoreSnapshot;
};

export type FetchStoreSnapshot = {
  json: () => Promise<unknown> | unknown;
};

export type FetchStore = {
  readConfig: () => Promise<any>;
  writeConfig: (config: unknown) => Promise<void>;
  readBindings: () => Promise<any[] | undefined>;
  writeBindings: (bindings: ReadonlyArray<unknown>) => Promise<void>;
};

export type ConfinedFetchServiceExo = {
  client: () => HttpClient;
  control: () => HttpClientControl;
  help: () => string;
};

export type ConfinedFetchService = {
  service: ConfinedFetchServiceExo;
  client: HttpClient;
  control: HttpClientControl;
};

export type ConfinedFetchServicePowers = {
  store: FetchStore;
  /** Built from the endowed `@endo/fetch` base; never the ambient `fetch`. */
  fetch: FetchLike;
  now?: () => number;
  allowedOrigins?: string[];
  maxRequestsPerMinute?: number;
  maxResponseBytes?: number;
  policyMode?: PolicyMode;
  policyAuthority?: PolicyAuthority;
};
