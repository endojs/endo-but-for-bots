// @ts-check

/**
 * @file `GitHttpHandler` for the gateway's `/git/<repo-id>/...`
 *   smart-HTTP endpoint (design Feature 3).
 *
 * The gateway hosts the Git **smart HTTP** protocol for push and pull,
 * authenticated by a formula-identifier bearer token. The URL shape is
 * `/git/<repo-id>/info/refs?service=git-upload-pack` (or
 * `git-receive-pack`), with `<repo-id>` a 64-character lowercase-hex
 * formula identifier (per `daemon-256-bit-identifiers.md`). The bearer
 * token is the same 64-character lowercase-hex shape carried in either
 * an HTTP `Authorization: Bearer <token>` header or an HTTP Basic
 * header with an empty username and the token as the password
 * (`Authorization: Basic ` followed by base64 of `:<token>`).
 * The empty-user Basic form is the canonical git-cli convention for
 * token-authenticated Git over HTTPS.
 *
 * This module implements the *semantic* core of Feature 3: given a
 * parsed HTTP request (method, url, headers, body bytes), it parses
 * the Authorization header, validates the URL path, resolves the
 * bearer token plus repo-id pair to a repo capability via a caller-
 * supplied `resolveRepo` adapter, and routes the smart-HTTP RPC
 * (`info/refs`, `git-upload-pack`, `git-receive-pack`) through that
 * capability. The gateway forwards the smart-HTTP request body to the
 * repo capability without parsing the Git protocol; the repo
 * capability's exo runs the actual Git server semantics (typically by
 * forwarding into the `@endo/endo-git` package's git server, but the
 * handler is agnostic to the repo's implementation).
 *
 * This module does **not** open an HTTP listener; that platform-bound
 * concern follows in a separate PR alongside the Feature 4 sock
 * listener and the Feature 8 WS upgrade. Until then, embedders that
 * already own an HTTP server hold the handler directly via
 * `makeGateway(...).getGitHttpHandler()` and feed it the per-request
 * shape.
 *
 * The exo uses `makeExo` + `M.interface` per `project/CLAUDE.md` §
 * Exo and Interface Authoring, so CapTP introspection
 * (`__getMethodNames__`) works out of the box.
 *
 * The repo capability the gateway forwards to is expected to expose
 * two methods, mirroring the design's Feature 3 prose:
 *
 *   gitUploadPack({ requestBody, requestHeaders }) -> { status, headers, body }
 *   gitReceivePack({ requestBody, requestHeaders }) -> { status, headers, body }
 *
 * plus an `infoRefs({ service, requestHeaders }) -> { status, headers, body }`
 * for the `info/refs?service=...` advertisement. The handler shapes the
 * call by URL path; the repo capability's exo holds the actual git
 * server.
 */

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { E, Far } from '@endo/far';
import { makeError, q, X } from '@endo/errors';
import { atob } from '@endo/base64';

/** @import { Reader, Writer } from '@endo/stream' */
/** @import {
 *   GitService,
 *   GitOperation,
 *   GitHttpRequest,
 *   GitHttpResponse,
 *   ResolveRepoArgs,
 *   RepoCapability,
 *   ResolveRepo,
 *   GitHttpHandler,
 * } from './types.d.ts' */

/**
 * The URL path prefix for the gateway's Git smart-HTTP endpoint.
 * Embedders that own the HTTP server compare the request's `url`
 * path against this constant (or the helper {@link isGitHttpPath}).
 */
export const GIT_HTTP_PATH_PREFIX = '/git/';
harden(GIT_HTTP_PATH_PREFIX);

/**
 * Git's `info/refs?service=...` service-name values for the two
 * smart-HTTP commands the gateway routes. Exported as a constant
 * tuple so the validator can produce a helpful "got X, expected
 * git-upload-pack|git-receive-pack" message and so a future third
 * service (e.g. the hypothetical `git-archive`) lands without a wide
 * grep through hard-coded strings.
 */
export const GIT_SERVICES = harden(['git-upload-pack', 'git-receive-pack']);

/**
 * @typedef {'git-upload-pack' | 'git-receive-pack'} GitService The
 *   two smart-HTTP service names. `git-upload-pack` is the fetch /
 *   clone direction (server-to-client); `git-receive-pack` is the
 *   push direction (client-to-server).
 */

/**
 * @typedef {'info/refs' | 'git-upload-pack' | 'git-receive-pack'} GitOperation
 *   The three smart-HTTP operations the handler routes. `info/refs`
 *   is the GET advertisement that announces the service's
 *   capabilities and refs; the other two are POST data exchanges.
 */

/**
 * The two formula-identifier shapes the gateway accepts as a repo-id
 * or bearer token: a bare 64-char hex (local formula number) or the
 * full `<number>:<node>` pair. Matches
 * `packages/daemon/src/formula-identifier.js`'s `numberPattern` and
 * `idPattern`; we keep our own copy rather than importing because
 * the gateway package does not depend on `@endo/daemon` (the daemon
 * embeds the gateway, not the other way around).
 */
const FORMULA_ID_PATTERN = /^[0-9a-f]{64}(?::[0-9a-f]{64})?$/;

/**
 * Test whether an HTTP request path names the Git smart-HTTP
 * endpoint. The check is structural (starts with `/git/` and has at
 * least one more path component) so the embedder does not have to
 * hard-code the prefix.
 *
 * Returns `true` for `/git/<repo-id>` and `/git/<repo-id>/...`;
 * returns `false` for `/git` or `/git/` (no repo-id), and for any
 * path that does not start with `/git/`.
 *
 * @param {string} path
 * @returns {boolean}
 */
export const isGitHttpPath = path => {
  if (typeof path !== 'string') return false;
  if (!path.startsWith(GIT_HTTP_PATH_PREFIX)) return false;
  // Require at least one character after the `/git/` prefix.
  return path.length > GIT_HTTP_PATH_PREFIX.length;
};
harden(isGitHttpPath);

/**
 * Validate that `candidate` matches the formula-identifier shape.
 * Accepts both the bare 64-char hex (local-formula) and the full
 * `<number>:<node>` pair forms; both are valid identifiers per
 * `daemon-256-bit-identifiers.md`.
 *
 * @param {unknown} candidate
 * @returns {string | undefined} the validated string, or `undefined`
 *   when the input is not a formula identifier.
 */
const validateFormulaId = candidate => {
  if (typeof candidate !== 'string') return undefined;
  if (!FORMULA_ID_PATTERN.test(candidate)) return undefined;
  return candidate;
};

/**
 * Decode a base64 string into a UTF-8 string. Uses `@endo/base64`'s
 * `atob` so the gateway does not depend on a host-provided WHATWG
 * `atob` (which exists in Node and browsers but not necessarily in
 * every SES realm we run under). Returns `undefined` when the input
 * is not valid base64; the handler treats that as an unauthorized
 * request rather than a 400.
 *
 * @param {string} encoded
 * @returns {string | undefined}
 */
const decodeBase64 = encoded => {
  try {
    return atob(encoded);
  } catch (_e) {
    return undefined;
  }
};

/**
 * Parse an HTTP Authorization header value and extract the bearer
 * token. Accepts both `Bearer <token>` and `Basic <base64(:token)>`
 * forms; returns `undefined` when the header is missing, malformed,
 * uses an unsupported scheme, or carries a non-empty Basic username.
 *
 * The Basic form with an empty username is the canonical git-cli
 * convention: `git push` over HTTPS to a token-authenticated server
 * sends `Authorization: Basic ` followed by base64 of `:<token>`.
 * The Bearer form is also accepted because `git-credential` supports
 * it after configuration; the design's Feature 3 names both.
 *
 * The function is exported so tests can exercise the parser
 * directly without standing up a full handler.
 *
 * @param {string | undefined} headerValue
 * @returns {string | undefined} the extracted token, or `undefined`.
 */
export const parseAuthorizationHeader = headerValue => {
  if (typeof headerValue !== 'string') return undefined;
  // Authorization headers are case-insensitive on the scheme name;
  // the rest is opaque. Normalize the scheme.
  const space = headerValue.indexOf(' ');
  if (space < 0) return undefined;
  const scheme = headerValue.slice(0, space).toLowerCase();
  const credentials = headerValue.slice(space + 1).trim();
  if (credentials.length === 0) return undefined;
  if (scheme === 'bearer') {
    return credentials;
  }
  if (scheme === 'basic') {
    const decoded = decodeBase64(credentials);
    if (decoded === undefined) return undefined;
    // Basic auth is `username:password`; we require an empty
    // username and treat the password as the token. Any non-empty
    // username is rejected so a future `<user>:<token>` shape does
    // not silently succeed by ignoring the username.
    const colon = decoded.indexOf(':');
    if (colon < 0) return undefined;
    const user = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);
    if (user.length !== 0) return undefined;
    if (password.length === 0) return undefined;
    return password;
  }
  return undefined;
};
harden(parseAuthorizationHeader);

/**
 * Parse a Git smart-HTTP URL path and return a structured
 * description of the operation. Returns `undefined` when the path
 * does not name a valid Git smart-HTTP route.
 *
 * Accepted shapes:
 *   `/git/<repo-id>/info/refs?service=<service>` (the `?service=`
 *     query is supplied by the caller via {@link parseGitHttpUrl},
 *     not parsed here; this function takes the path only).
 *   `/git/<repo-id>/git-upload-pack`
 *   `/git/<repo-id>/git-receive-pack`
 *
 * The `<repo-id>` is validated as a formula identifier shape (64
 * lowercase hex chars optionally followed by `:<node>`); a malformed
 * id yields `undefined`.
 *
 * @param {string} path
 * @returns {{ repoId: string, operation: GitOperation } | undefined}
 */
export const parseGitHttpPath = path => {
  if (typeof path !== 'string') return undefined;
  if (!path.startsWith(GIT_HTTP_PATH_PREFIX)) return undefined;
  const rest = path.slice(GIT_HTTP_PATH_PREFIX.length);
  // The repo-id is the first path segment; the operation is the
  // remainder. We split on the first `/` to recover the two halves.
  const slash = rest.indexOf('/');
  if (slash < 0) return undefined;
  const repoIdRaw = rest.slice(0, slash);
  const opPath = rest.slice(slash + 1);
  const repoId = validateFormulaId(repoIdRaw);
  if (repoId === undefined) return undefined;
  if (opPath === 'info/refs') {
    return harden({
      repoId,
      operation: /** @type {GitOperation} */ ('info/refs'),
    });
  }
  if (opPath === 'git-upload-pack') {
    return harden({
      repoId,
      operation: /** @type {GitOperation} */ ('git-upload-pack'),
    });
  }
  if (opPath === 'git-receive-pack') {
    return harden({
      repoId,
      operation: /** @type {GitOperation} */ ('git-receive-pack'),
    });
  }
  return undefined;
};
harden(parseGitHttpPath);

/**
 * Parse the `service` query parameter from a smart-HTTP URL. The
 * `info/refs` GET carries `?service=git-upload-pack` (or
 * `git-receive-pack`); without it, the request is the deprecated
 * "dumb HTTP" protocol the gateway does not support.
 *
 * Returns `undefined` when the parameter is missing or names an
 * unrecognized service. The handler treats `undefined` as a 400.
 *
 * @param {string} query e.g. `service=git-upload-pack` (no `?`).
 * @returns {GitService | undefined}
 */
export const parseServiceQuery = query => {
  if (typeof query !== 'string' || query.length === 0) return undefined;
  // Walk the query string by `&` so callers can pass the raw query
  // (without the leading `?`) and we still find a `service=...`
  // anywhere in the list.
  const params = query.split('&');
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq >= 0) {
      const name = param.slice(0, eq);
      if (name === 'service') {
        const value = param.slice(eq + 1);
        if (value === 'git-upload-pack') {
          return /** @type {GitService} */ ('git-upload-pack');
        }
        if (value === 'git-receive-pack') {
          return /** @type {GitService} */ ('git-receive-pack');
        }
        return undefined;
      }
    }
  }
  return undefined;
};
harden(parseServiceQuery);

const GitHttpHandlerInterface = M.interface('GitHttpHandler', {
  handleRequest: M.call(M.raw()).returns(M.promise()),
});
harden(GitHttpHandlerInterface);

/**
 * @typedef {object} GitHttpDeps Inputs to {@link makeGitHttpHandler}.
 * @property {ResolveRepo} resolveRepo The bearer-token + repo-id
 *   resolver the gateway is wired with. See the `ResolveRepo`
 *   typedef in `types.d.ts`.
 */

/**
 * Render a header list as a lowercase-name lookup map. Header names
 * are case-insensitive per RFC 7230; we normalize for internal
 * lookups. Returns the first matching value when a header is
 * repeated; the smart-HTTP protocol does not duplicate the headers
 * we look up (`Authorization`, `Content-Type`).
 *
 * @param {ReadonlyArray<readonly [string, string]>} headers
 * @param {string} name The header name to look up (any casing).
 * @returns {string | undefined}
 */
const findHeader = (headers, name) => {
  const target = name.toLowerCase();
  for (const [k, v] of headers) {
    if (typeof k === 'string' && k.toLowerCase() === target) {
      return v;
    }
  }
  return undefined;
};

/**
 * Build a {@link GitHttpResponse} with the given status and a plain
 * `text/plain; charset=utf-8` body. Used for the error paths
 * (`401 Unauthorized`, `400 Bad Request`, `500 Internal Server
 * Error`); the success paths return the repo capability's response
 * verbatim.
 *
 * The `WWW-Authenticate` header on the 401 shape names both
 * supported schemes so a Git client that received it knows which
 * credential to send back; the realm is fixed to `"Endo Gateway"`
 * so the user-agent presents a recognizable prompt.
 *
 * @param {number} status
 * @param {string} message
 * @param {boolean} [withChallenge] Add a `WWW-Authenticate` header
 *   when `true`. Defaults to `false`; the 401 callers pass `true`.
 * @returns {GitHttpResponse}
 */
const errorResponse = (status, message, withChallenge = false) => {
  const body = new TextEncoder().encode(message);
  const headers = withChallenge
    ? [
        /** @type {readonly [string, string]} */ ([
          'content-type',
          'text/plain; charset=utf-8',
        ]),
        /** @type {readonly [string, string]} */ ([
          'www-authenticate',
          'Basic realm="Endo Gateway", Bearer realm="Endo Gateway"',
        ]),
      ]
    : [
        /** @type {readonly [string, string]} */ ([
          'content-type',
          'text/plain; charset=utf-8',
        ]),
      ];
  return harden({
    status,
    headers: harden(headers),
    body,
  });
};

/**
 * Create the `GitHttpHandler` exo. The factory is total: it returns
 * the exo unconditionally and the caller (the gateway proper,
 * `index.js`) decides whether to expose it based on the `gitHttp`
 * feature toggle.
 *
 * @param {GitHttpDeps} deps
 * @returns {GitHttpHandler}
 */
export const makeGitHttpHandler = ({ resolveRepo }) => {
  if (typeof resolveRepo !== 'function') {
    throw makeError(X`makeGitHttpHandler requires a resolveRepo function`);
  }

  const exo = makeExo(
    'GitHttpHandler',
    GitHttpHandlerInterface,
    /** @type {any} */ ({
      /** @param {GitHttpRequest} request */
      async handleRequest(request) {
        if (request === null || typeof request !== 'object') {
          throw makeError(X`handleRequest expects a request object`);
        }
        const { method, path, query, headers, body } = request;
        if (typeof method !== 'string' || method.length === 0) {
          throw makeError(
            X`handleRequest: request.method must be a non-empty string`,
          );
        }
        if (typeof path !== 'string' || path.length === 0) {
          throw makeError(
            X`handleRequest: request.path must be a non-empty string`,
          );
        }
        if (!Array.isArray(headers)) {
          throw makeError(X`handleRequest: request.headers must be an array`);
        }
        if (!(body instanceof Uint8Array)) {
          throw makeError(
            X`handleRequest: request.body must be a Uint8Array, got ${q(typeof body)}`,
          );
        }

        // Parse the URL path. A non-Git path returns 400 from the
        // handler (the embedder should not have routed it here, but
        // the local check is defense-in-depth so a routing bug at
        // the embedder does not silently return a misleading 401).
        const parsed = parseGitHttpPath(path);
        if (parsed === undefined) {
          return errorResponse(
            400,
            `not a recognized git smart-HTTP path: ${path}\n`,
          );
        }
        const { repoId, operation } = parsed;

        // Match the HTTP method. The smart-HTTP protocol fixes:
        //   GET  /git/<id>/info/refs?service=<svc>
        //   POST /git/<id>/git-upload-pack
        //   POST /git/<id>/git-receive-pack
        // Any other combination is a 400.
        const methodUp = method.toUpperCase();
        if (operation === 'info/refs' && methodUp !== 'GET') {
          return errorResponse(
            400,
            `info/refs requires GET, got ${methodUp}\n`,
          );
        }
        if (
          (operation === 'git-upload-pack' ||
            operation === 'git-receive-pack') &&
          methodUp !== 'POST'
        ) {
          return errorResponse(
            400,
            `${operation} requires POST, got ${methodUp}\n`,
          );
        }

        // For `info/refs`, the service query parameter is required
        // and must match the path: a request like
        // `info/refs?service=git-upload-pack` is the advertisement
        // for the upload-pack service. A missing or unrecognized
        // service is the dumb-HTTP fallback the gateway does not
        // support.
        /** @type {GitService | undefined} */
        let service;
        if (operation === 'info/refs') {
          service = parseServiceQuery(query ?? '');
          if (service === undefined) {
            return errorResponse(
              400,
              'info/refs requires ?service=git-upload-pack or ?service=git-receive-pack\n',
            );
          }
        } else if (operation === 'git-upload-pack') {
          service = 'git-upload-pack';
        } else {
          service = 'git-receive-pack';
        }

        // Parse the Authorization header. Missing or malformed: 401
        // with a challenge so the Git client knows to retry with
        // credentials.
        const authHeader = findHeader(headers, 'authorization');
        const token = parseAuthorizationHeader(authHeader);
        if (token === undefined) {
          return errorResponse(401, 'Unauthorized\n', true);
        }
        if (validateFormulaId(token) === undefined) {
          // Token doesn't look like a formula identifier. We still
          // return 401 (rather than 400) so a probing attacker
          // cannot distinguish "malformed token" from "wrong token";
          // both are unauthorized as far as the surface tells.
          return errorResponse(401, 'Unauthorized\n', true);
        }

        // Resolve the (token, repoId) pair to a repo capability.
        /** @type {RepoCapability | undefined} */
        let repo;
        try {
          repo = await resolveRepo(harden({ token, repoId }));
        } catch (e) {
          console.error(
            `[Gateway] resolveRepo threw for repoId=${repoId}:`,
            /** @type {Error} */ (e).message,
          );
          return errorResponse(500, 'Internal Server Error\n');
        }
        if (repo === undefined) {
          // Either the token does not authorize access or the repo
          // does not exist. The handler conflates the two so a
          // probing attacker cannot enumerate repo ids; see the
          // ResolveRepo typedef.
          return errorResponse(401, 'Unauthorized\n', true);
        }

        // Forward to the appropriate method on the repo capability.
        // Pass the request headers through verbatim so the repo
        // capability can read Content-Type, Accept, Git-Protocol,
        // etc. The repo capability owns the actual git server.
        try {
          if (operation === 'info/refs') {
            return await E(repo).infoRefs(harden({ service, headers }));
          }
          if (operation === 'git-upload-pack') {
            return await E(repo).gitUploadPack(
              harden({ requestBody: body, headers }),
            );
          }
          return await E(repo).gitReceivePack(
            harden({ requestBody: body, headers }),
          );
        } catch (e) {
          console.error(
            `[Gateway] ${operation} for repoId=${repoId} threw:`,
            /** @type {Error} */ (e).message,
          );
          return errorResponse(500, 'Internal Server Error\n');
        }
      },
    }),
  );

  return /** @type {GitHttpHandler} */ (/** @type {unknown} */ (exo));
};
harden(makeGitHttpHandler);

/**
 * Convenience: a `Far`-tagged trivial-streams adapter that wraps a
 * `Uint8Array` body as a `Reader<Uint8Array>` yielding the buffer in
 * a single chunk. Exported for tests and for embedders that want to
 * push from the buffered shape into a streaming pipeline; the handler
 * itself only deals in buffered bodies.
 *
 * The reader is `Far`-tagged so it crosses the CapTP boundary into a
 * repo capability that expects a streamed body without tripping
 * passable-style enforcement; the same pattern Phase 4's ocapn-ws
 * uses for its replay reader.
 *
 * @param {Uint8Array} body
 * @returns {Reader<Uint8Array>}
 */
export const readerFromBuffer = body => {
  if (!(body instanceof Uint8Array)) {
    throw makeError(
      X`readerFromBuffer expects a Uint8Array, got ${q(typeof body)}`,
    );
  }
  let yielded = false;
  return /** @type {Reader<Uint8Array>} */ (
    /** @type {unknown} */ (
      Far('GitHttpBufferReader', {
        next: async () => {
          if (yielded) {
            return harden({ done: true, value: undefined });
          }
          yielded = true;
          return harden({ done: false, value: body });
        },
        return: async value => {
          yielded = true;
          return harden({ done: true, value });
        },
        throw: async err => {
          yielded = true;
          throw err;
        },
      })
    )
  );
};
harden(readerFromBuffer);
