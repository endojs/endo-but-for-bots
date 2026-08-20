export type FetchLikeBodyReader = {
  read: () => Promise<{ done?: boolean; value?: unknown }>;
  cancel?: (reason?: unknown) => Promise<void>;
  releaseLock?: () => void;
};

export type FetchLikeResponse = {
  body?: {
    getReader: () => FetchLikeBodyReader;
  } | null;
  status?: number;
  statusText?: string;
  ok?: boolean;
  headers?: Headers | Record<string, string> | Iterable<[string, string]>;
  url?: string;
};

export type FetchLikeRequestOptions = {
  redirect: 'manual';
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * Declared only for a streamed body. The platform `fetch` requires the
   * half-duplex declaration before it will accept an async iterable body.
   */
  duplex?: 'half';
  signal?: AbortSignal;
};

export type FetchLike = (
  url: string,
  options?: FetchLikeRequestOptions,
) => Promise<FetchLikeResponse> | FetchLikeResponse;

export type HttpConfinementPolicy = {
  allowedOrigins?: string[] | (() => string[]);
  maxRequestsPerMinute?: number;
  maxResponseBytes?: number;
  /**
   * Cap on the bytes a request body may carry. A body of knowable size is
   * refused before the request is dialed; a streamed body is refused at the
   * first frame that crosses the cap. Over-limit always fails closed: unlike a
   * response, a request body is never truncated.
   */
  maxRequestBytes?: number;
  timeoutMs?: number;
  allowedMethods?: Set<string>;
};

export type ConfinedRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  cancellation?: Promise<never>;
};

export type ConfinedResponse = {
  response: FetchLikeResponse;
  bytes: Uint8Array;
  truncated: boolean;
  maxResponseBytes: number;
};
