import type {
  FetchLike,
  HttpClient,
  HttpClientControl,
  PolicyAuthority,
  PolicyMode,
  PolicySnapshot,
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

export type PersistedSnapshot = PolicySnapshot;

export type FetchStore = {
  readSnapshot: () => Promise<PersistedSnapshot | undefined>;
  writeSnapshot: (snapshot: PersistedSnapshot) => Promise<void>;
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
  fetch: FetchLike;
  delay: (
    milliseconds: number,
    cancelled: Promise<never>,
  ) => Promise<undefined>;
  now: () => number | Promise<number>;
  allowedOrigins?: string[];
  maxRequestsPerMinute?: number;
  maxResponseBytes?: number;
  policyMode?: PolicyMode;
  policyAuthority?: PolicyAuthority;
};
