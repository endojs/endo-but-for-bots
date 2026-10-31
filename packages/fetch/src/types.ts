// spell-out-exempt: `ok` is the platform Response field these types mirror.
import type { CloseablePassableBytesReader } from '@endo/exo-stream';

export type FetchRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: 'manual' | 'follow' | 'error';
  /** An `@endo/cancel` token; rejecting it aborts the request and its body. */
  cancelled?: PromiseLike<unknown>;
};

export type FetchResponse = {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Record<string, string>;
  url: string;
  /** Null for a null-body response (204, 205, 304, and answers to HEAD). */
  body: CloseablePassableBytesReader | null;
};

/** The `Fetch` capability's remote surface. */
export type Fetch = {
  fetch: (url: string, options?: FetchRequestOptions) => Promise<FetchResponse>;
  help: () => string;
};

export type TransportBodyReader = {
  read: () => Promise<{ done?: boolean; value?: unknown }>;
  cancel?: (reason?: unknown) => Promise<void>;
  releaseLock?: () => void;
};

export type TransportBody = {
  getReader: () => TransportBodyReader;
};

export type TransportResponse = {
  status: number;
  statusText?: string;
  ok?: boolean;
  headers?: Headers | Record<string, string> | Iterable<[string, string]>;
  url?: string;
  body?: TransportBody | null;
};

/** The platform `fetch`, or a test double of it. */
export type Transport = (
  url: string,
  options: Omit<FetchRequestOptions, 'cancelled'> & { signal?: AbortSignal },
) => Promise<TransportResponse>;

export type Timer = {
  delay: (
    milliseconds: number,
    cancelled?: PromiseLike<never>,
  ) => Promise<void>;
  now: () => Promise<number>;
  help: () => string;
};
