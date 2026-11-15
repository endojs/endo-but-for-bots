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
  /** The Fetch Standard response type, such as `basic` or `opaqueredirect`. */
  type: string;
  status: number;
  statusText: string;
  ok: boolean;
  headers: Record<string, string>;
  url: string;
  /** Null for a null-body response (204, 205, 304, and answers to HEAD). */
  body: CloseablePassableBytesReader | null;
};

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
  type?: string;
  status: number;
  statusText?: string;
  ok?: boolean;
  headers?: Headers | Record<string, string> | Iterable<[string, string]>;
  url?: string;
  body?: TransportBody | null;
};

export type Transport = (
  url: string,
  options: Omit<FetchRequestOptions, 'cancelled'> & { signal?: AbortSignal },
) => Promise<TransportResponse>;

export type Timer = {
  delay: (
    milliseconds: number,
    cancelled?: PromiseLike<never>,
  ) => Promise<undefined>;
  now: () => Promise<number>;
  help: () => string;
};
