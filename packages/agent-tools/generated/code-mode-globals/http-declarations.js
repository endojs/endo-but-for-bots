// @ts-check
/// <reference types="ses"/>

/**
 * GENERATED FILE - do not edit by hand.
 *
 * Regenerate with: yarn workspace @endo/agent-tools gen:code-mode-types
 *
 * Source of truth:
 *   - http: packages/exo-http-client/src/types.ts (the `HttpClient` type
 *     alias), printed by the TypeScript compiler API, with
 *     `PassableBytesReader` and the stream nodes it reaches followed into
 *     packages/exo-stream/types.d.ts.
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
    aux: `type HttpResponse = {
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
type HttpPassableBytesReader<TReadReturn = undefined> = {
    streamBase64: (synPromise: HttpERef<HttpStreamNode<unknown, TReadReturn>>) => Promise<HttpStreamNode<string, TReadReturn>>;
    readReturnPattern: () => unknown | undefined;
};
type HttpERef<T> = T | Promise<T>;
type HttpStreamNode<Y = undefined, R = undefined> = HttpStreamYieldNode<Y, R> | {
    value: R;
    promise: null;
};
type HttpStreamYieldNode<Y = unknown, R = undefined> = {
    value: Y;
    promise: Promise<HttpStreamNode<Y, R>>;
};`,
    body: `{
    allowedOrigins: () => string[];
    fetch: (url: string, options?: {
        method?: string;
        headers?: Record<string, string>;
        body?: unknown;
    }) => Promise<HttpResponse>;
    help: () => string;
}`,
  },
});
harden(httpDeclarations);
