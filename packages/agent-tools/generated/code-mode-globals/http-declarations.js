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
type HttpPassable<PC = HttpPassableCap, E = Error> = void | HttpAtom | (HttpCopyArrayInterface<PC, E> | HttpCopyRecordInterface<PC, E> | HttpCopyTaggedInterface<PC, E>) | PC | E;
type HttpPassStyled<S = unknown, I = unknown> = {
    "Symbol(passStyle)": S;
    [Symbol.toStringTag]: I;
};
type HttpPassableBytesReader<TReadReturn = undefined> = {
    streamBase64: (synPromise: HttpERef<HttpStreamNode<HttpPassable, TReadReturn>>) => Promise<HttpStreamNode<string, TReadReturn>>;
    readReturnPattern: () => HttpPattern | undefined;
};
type HttpPassableCap = Promise<any> | HttpRemotableObject | unknown;
type HttpAtom = undefined | null | boolean | number | bigint | string | Uint8Array | symbol;
type HttpERef<T = unknown> = PromiseLike<T> | T;
type HttpStreamNode<Y = undefined, R = undefined> = HttpStreamYieldNode<Y, R> | {
    value: R;
    promise: null;
};
type HttpPattern = Exclude<HttpPassable, Error | Promise<any>>;
type HttpRemotableObject<I = string> = HttpPassStyled<'remotable', I>;
type HttpStreamYieldNode<Y = unknown, R = undefined> = {
    value: Y;
    promise: Promise<HttpStreamNode<Y, R>>;
};
type HttpCopyArray<T = any> = readonly T[];
type HttpCopyRecord<T = any> = Record<string, T>;
type HttpCopyTagged<Tag = string, Payload = any> = HttpPassStyled<'tagged', Tag> & {
    payload: Payload;
};
interface HttpCopyArrayInterface<PC = unknown, E = unknown> extends HttpCopyArray<HttpPassable<PC, E>> {
}
interface HttpCopyRecordInterface<PC = unknown, E = unknown> extends HttpCopyRecord<HttpPassable<PC, E>> {
}
interface HttpCopyTaggedInterface<PC = unknown, E = unknown> extends HttpCopyTagged<string, HttpPassable<PC, E>> {
}`,
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
