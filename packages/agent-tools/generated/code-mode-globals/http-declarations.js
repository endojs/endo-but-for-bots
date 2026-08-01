// @ts-check
/// <reference types="ses"/>

/**
 * GENERATED FILE - do not edit by hand.
 *
 * Regenerate with: yarn workspace @endo/agent-tools gen:code-mode-types
 *
 * Source of truth:
 *   - http: packages/exo-http-client/src/types.ts (the `HttpClient` type
 *     alias), printed by the TypeScript compiler API. The small
 *     `PassableBytesReader` contract is authored by its focused extractor.
 *
 * The generic extraction and rendering live in
 * scripts/code-mode-type-extract.js; this exo's source configuration lives in
 * its scripts/code-mode-*-extract.js extractor. The divergence gate in
 * test/code-mode-types.test.js keeps this artifact fresh.
 *
 * Each entry is consumed by formatGlobalDeclarations in code-mode/declarations.js via
 * the per-exo descriptor in code-mode-globals/http.js:
 * `aux` is the supporting `type` aliases, `body` is the object type spliced
 * after the dynamic `declare const <name>:`.
 */

export const httpDeclarations = harden({
  http: {
    aux: `type HttpClient = {
  fetch: (url: string, options?: HttpFetchOptions) => Promise<HttpResponse>;
  allowedOrigins: () => string[];
  help: () => string;
};
type HttpFetchOptions = {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
};
type HttpResponse = {
    status: () => number;
    statusText: () => string;
    ok: () => boolean;
    headers: () => Record<string, string>;
    url: () => string;
    truncated: () => boolean;
    maxResponseBytes: () => number;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    stream: () => HttpPassableBytesReader;
    help: () => string;
};
type HttpStreamInputNode = {
  value: unknown;
  promise: Promise<HttpStreamInputNode> | null;
};
type HttpStreamOutputNode = {
  value: string | undefined;
  promise: Promise<HttpStreamOutputNode> | null;
};
type HttpPassableBytesReader = {
  streamBase64: (
    synPromise: HttpStreamInputNode | Promise<HttpStreamInputNode>,
  ) => Promise<HttpStreamOutputNode>;
  readReturnPattern: () => unknown | undefined;
};`,
    body: `HttpClient`,
  },
});
harden(httpDeclarations);
