// @ts-check

/**
 * @file Virtual-host content-tree resolution and static serving for
 * the gateway (`designs/gateway-package.md` § Feature 2, steps 1-5).
 *
 * Given an inbound request `(Host, path)`, the resolver:
 *
 *   1. Looks the `Host` value up in the `@apps` {@link AppsNameHub}
 *      table to get the canonical weblet formula identifier.
 *   2. Resolves that identifier to a {@link WebletFormula} through
 *      the injected {@link GatewayContentResolver}.
 *   3. Resolves the request path (defaulting to `index.html`)
 *      against the formula's `contentRoot`, a content-addressed
 *      `readable-tree` per `designs/daemon-weblet-application.md`.
 *   4. Serves the bytes with the formula's `mimeTypes` overrides
 *      applied and otherwise inferred.
 *
 * A **CAS read-through cache** keyed by content address (the
 * `contentRoot` formula identifier, which is content-addressed)
 * holds the resolved content tree. On a cache miss the resolver
 * fetches the tree once and populates the cache; subsequent
 * requests for the same root serve from the cached tree. This is
 * the cache-hit / cache-miss path of the design's sequence diagram.
 *
 * The path is **powers-injected and daemon-free**: the resolution
 * and tree-read capabilities arrive as a {@link GatewayContentResolver}
 * so the whole path is unit-testable against an in-memory fake, with
 * no live socket or daemon. The eventual Phase-1 integration adapts
 * the daemon's real formula store and `readable-tree` to this shape.
 *
 * Out of scope for this increment (named seams, not implemented
 * here):
 *   - The **SSR dynamic-fallback** handler (`ssrHandler` →
 *     `UserDaemon.handleHttp`) is Feature 4 / Phase 2. A request
 *     that misses the static tree on a weblet that declares an
 *     `ssrHandler` returns a `501 ssr-not-wired` result so the seam
 *     is visible; the CapTP forward is not built here.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E } from '@endo/far';
import { makeError, q, X } from '@endo/errors';

import { inferContentType } from './mime.js';

/** @import { AppsNameHub, GatewayContentResolver, WebletFormula, ServeResult, WebletResolver } from '../types.d.ts' */

/**
 * The default file served when the request path resolves to a
 * directory root (an empty path or a trailing slash). Static web
 * servers conventionally serve `index.html` for `/`.
 */
export const DEFAULT_INDEX = 'index.html';
harden(DEFAULT_INDEX);

/**
 * Normalize a request path into an array of clean path segments,
 * rejecting traversal. Returns `undefined` when the path is unsafe
 * (a `..` segment or an embedded NUL); the caller turns that into a
 * `404 invalid-path` rather than leaking which paths exist.
 *
 * `'/'`, `''`, and any trailing-slash path resolve to
 * {@link DEFAULT_INDEX} appended to the directory segments.
 *
 * @param {string} path
 * @returns {string[] | undefined}
 */
export const normalizeRequestPath = path => {
  if (typeof path !== 'string') {
    return undefined;
  }
  // Drop a query string or fragment if a caller passed a raw target.
  const queryIndex = path.search(/[?#]/);
  const pathOnly = queryIndex < 0 ? path : path.slice(0, queryIndex);
  // A trailing slash (or the bare root) names the directory index.
  const withIndex =
    pathOnly === '' || pathOnly.endsWith('/')
      ? `${pathOnly}${DEFAULT_INDEX}`
      : pathOnly;
  const rawSegments = withIndex.split('/');
  /** @type {string[]} */
  const segments = [];
  for (const segment of rawSegments) {
    if (segment === '..' || segment.includes('\0')) {
      // Path traversal or an embedded NUL: reject the whole request.
      return undefined;
    }
    if (segment !== '' && segment !== '.') {
      // Keep real segments; collapse empty (leading or double
      // slash) and `.`.
      segments.push(segment);
    }
  }
  if (segments.length === 0) {
    // The path collapsed to nothing (e.g. `/./`): serve the index.
    return [DEFAULT_INDEX];
  }
  return segments;
};
harden(normalizeRequestPath);

/**
 * Validate a value that claims to be a {@link WebletFormula}. The
 * formula crosses a capability boundary (it comes back from the
 * injected resolver), so the gateway checks its shape before
 * trusting `contentRoot`.
 *
 * @param {unknown} formula
 * @returns {WebletFormula}
 */
const asWebletFormula = formula => {
  if (typeof formula !== 'object' || formula === null) {
    throw makeError(X`Weblet formula must be an object, got ${q(formula)}`);
  }
  const candidate = /** @type {Record<string, unknown>} */ (formula);
  if (candidate.type !== 'weblet') {
    throw makeError(
      X`Weblet formula must have type 'weblet', got ${q(candidate.type)}`,
    );
  }
  if (
    typeof candidate.contentRoot !== 'string' ||
    candidate.contentRoot === ''
  ) {
    throw makeError(
      X`Weblet formula contentRoot must be a non-empty string, got ${q(candidate.contentRoot)}`,
    );
  }
  return /** @type {WebletFormula} */ (formula);
};

const ServeResultShape = M.or(
  // 200: served bytes.
  harden({
    status: 200,
    webletFormulaId: M.string(),
    contentRoot: M.string(),
    path: M.arrayOf(M.string()),
    mimeType: M.string(),
    bytes: M.any(),
  }),
  // 404: no such host, no such file, or an unsafe path.
  harden({
    status: 404,
    reason: M.or('unknown-host', 'not-found', 'invalid-path'),
  }),
  // 501: the static tree missed and the weblet declares an
  // ssrHandler we have not wired yet (Feature 4 / Phase 2).
  harden({
    status: 501,
    reason: 'ssr-not-wired',
    ssrHandler: M.string(),
  }),
);

const WebletResolverInterface = M.interface('GatewayWebletResolver', {
  serve: M.call(M.string(), M.string()).returns(M.promise()),
});

/**
 * Create the virtual-host weblet resolver / static server exo.
 *
 * @param {object} args
 * @param {AppsNameHub} args.apps the `@apps` routing table.
 * @param {GatewayContentResolver} args.content the injected
 *   formula-resolver / content-tree-reader capability.
 * @returns {WebletResolver}
 */
export const makeWebletResolver = ({ apps, content }) => {
  if (apps === undefined || content === undefined) {
    throw makeError(
      X`makeWebletResolver requires both an apps NameHub and a content resolver`,
    );
  }

  /**
   * The CAS read-through cache, keyed by content address (the
   * `contentRoot` formula identifier). The value is the in-flight
   * *promise* of the content tree, not the resolved tree, so that
   * concurrent requests for the same root share a single
   * `fetchContentTree` rather than each issuing their own. A
   * rejected fetch is evicted so a later request retries.
   *
   * @type {Map<string, Promise<import('../types.d.ts').WebletContentTree>>}
   */
  const contentTreeCache = new Map();

  /**
   * Resolve a content tree by its content-address root, fetching it
   * at most once per root (cache hit on the in-flight or settled
   * promise).
   *
   * @param {string} contentRoot
   */
  const provideContentTree = contentRoot => {
    const cached = contentTreeCache.get(contentRoot);
    if (cached !== undefined) {
      return cached;
    }
    const pending = E(content).fetchContentTree(contentRoot);
    // Cache the promise synchronously, before any await, so a
    // concurrent request observes the in-flight fetch.
    contentTreeCache.set(contentRoot, pending);
    pending.catch(() => {
      // A failed fetch must not poison the cache: evict so the next
      // request re-fetches rather than re-awaiting the rejection.
      if (contentTreeCache.get(contentRoot) === pending) {
        contentTreeCache.delete(contentRoot);
      }
    });
    return pending;
  };

  const exo = makeExo(
    'GatewayWebletResolver',
    WebletResolverInterface,
    /** @type {WebletResolver} */ ({
      /**
       * @param {string} host the inbound `Host` header value.
       * @param {string} path the inbound request path.
       * @returns {Promise<ServeResult>}
       */
      async serve(host, path) {
        await null; // safe-await-separator (Jessie discipline).
        // 1. Route the Host header through the @apps table.
        if (!(await E(apps).has(host))) {
          return harden({ status: 404, reason: 'unknown-host' });
        }
        const webletFormulaId = await E(apps).lookup(host);

        // 2. Resolve the weblet formula.
        const formula = asWebletFormula(
          await E(content).resolveWebletFormula(webletFormulaId),
        );
        const { contentRoot } = formula;

        // 3. Normalize and bound the request path.
        const segments = normalizeRequestPath(path);
        if (segments === undefined) {
          return harden({ status: 404, reason: 'invalid-path' });
        }

        // 4. Resolve the content tree (CAS read-through cache).
        const tree = await provideContentTree(contentRoot);

        // 5. Read the file, or fall through to the SSR seam.
        if (!(await E(tree).has(segments))) {
          if (formula.ssrHandler !== undefined) {
            // Static miss on an SSR-capable weblet. The dynamic
            // CapTP forward to UserDaemon.handleHttp is Feature 4 /
            // Phase 2; leave the seam visible rather than 404.
            return harden({
              status: 501,
              reason: 'ssr-not-wired',
              ssrHandler: formula.ssrHandler,
            });
          }
          return harden({ status: 404, reason: 'not-found' });
        }

        let bytes;
        try {
          // `lookup` returns a file readable or a subtree; we asked
          // `has` for a leaf, so treat it as a readable and let the
          // `bytes()` call reject (caught below) if it is a directory.
          const readable =
            /** @type {import('../types.d.ts').WebletReadable} */ (
              await E(tree).lookup(segments)
            );
          bytes = await E(readable).bytes();
        } catch {
          // The path resolved to a directory (or a non-file node):
          // there is no readable to serve.
          return harden({ status: 404, reason: 'not-found' });
        }

        const fileName = segments[segments.length - 1];
        const mimeType = inferContentType(fileName, formula.mimeTypes);

        return harden({
          status: 200,
          webletFormulaId,
          contentRoot,
          path: harden([...segments]),
          mimeType,
          bytes,
        });
      },
    }),
  );

  return /** @type {WebletResolver} */ (/** @type {unknown} */ (exo));
};
harden(makeWebletResolver);

// Documents the wire contract for future readers; silences
// eslint's no-unused-vars on the shape constant.
void ServeResultShape;
