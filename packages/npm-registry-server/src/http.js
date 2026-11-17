// @ts-check

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { canonicalizePackageName } from './names.js';
import {
  RegistryHttpError,
  STATUS_ERRORS,
  isRegistryHttpError,
} from './errors.js';

/** @import { IncomingMessage, ServerResponse } from 'node:http' */
/** @import { Registry } from './registry.js' */
/** @import { Grants } from './grants.js' */

const INSTALL_V1 = 'application/vnd.npm.install-v1+json';

/**
 * @typedef {object} RequestLog
 * @property {string} method
 * @property {string} path
 * @property {number} status
 * @property {number} ms
 * @property {string} [subject]
 */

/**
 * Split a request path into the canonical package name and the remainder.
 * Accepts npm's `@scope%2fname` and the slash spelling `@scope/name`.
 *
 * @param {string[]} segments raw (still percent-encoded) path segments
 * @returns {{ name: string, rest: string[] }}
 */
const splitPackagePath = segments => {
  const [first, ...rest] = segments;
  if (first.startsWith('@') && !/%2f/iu.test(first)) {
    if (rest.length === 0) {
      throw RegistryHttpError(404, 'Not found');
    }
    const [second, ...tail] = rest;
    return { name: canonicalizePackageName(`${first}/${second}`), rest: tail };
  }
  return { name: canonicalizePackageName(first), rest };
};

/**
 * @param {IncomingMessage} request
 * @param {number} maxBytes
 * @returns {Promise<any>}
 */
const readJsonBody = async (request, maxBytes) => {
  const declared = Number(request.headers['content-length']);
  if (declared > maxBytes) {
    throw RegistryHttpError(413, 'Request body exceeds the size limit');
  }
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      throw RegistryHttpError(413, 'Request body exceeds the size limit');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw RegistryHttpError(400, 'Request body is not JSON');
  }
};

/**
 * @param {IncomingMessage} request
 * @returns {string | undefined}
 */
const bearerOf = request => {
  const header = request.headers.authorization;
  const match = header && /^Bearer\s+(\S+)$/iu.exec(header);
  return match ? match[1] : undefined;
};

/**
 * Percent-decode one URL path segment, refusing a malformed escape as a
 * client error rather than letting its `URIError` become a 500.
 *
 * @param {string} segment
 * @param {string} what
 * @returns {string}
 */
const decodeSegment = (segment, what) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw RegistryHttpError(400, `Invalid ${what} encoding`);
  }
};

/**
 * The npm registry HTTP surface of the proposed design
 * `designs/npm-dev-registry-serving.md` (not yet landed; see
 * https://github.com/endojs/endo-but-for-bots/pull/1361) § npm registry HTTP surface. Reads are public; mutations authenticate a
 * `PublishGrant` bearer. The adapter trusts no forwarded identity header,
 * and never logs Authorization.
 *
 * @param {object} options
 * @param {Registry} options.registry
 * @param {Pick<Grants, 'authenticate'>} options.grants only
 *   authentication; the handler never writes grants.
 * @param {number} [options.maxBodyBytes] publish document ceiling
 * @param {(entry: RequestLog) => void} [options.log]
 */
export const makeRequestHandler = ({
  registry,
  grants,
  maxBodyBytes = 64 * 1024 * 1024,
  log = () => {},
}) => {
  /**
   * @param {IncomingMessage} request
   * @param {ServerResponse} response
   * @param {number} status
   * @param {unknown} value
   * @param {string} [contentType]
   */
  const sendJson = (request, response, status, value, contentType) => {
    const body = Buffer.from(JSON.stringify(value));
    const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
    if (status === 200 && request.headers['if-none-match'] === etag) {
      response.writeHead(304, { etag, 'cache-control': 'no-cache' });
      response.end();
      return 304;
    }
    response.writeHead(status, {
      'content-type': contentType ?? 'application/json',
      'content-length': body.length,
      'cache-control': 'no-cache',
      etag,
    });
    response.end(request.method === 'HEAD' ? undefined : body);
    return status;
  };

  /**
   * @param {IncomingMessage} request
   * @param {ServerResponse} response
   * @returns {Promise<{ status: number, subject?: string }>}
   */
  const route = async (request, response) => {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://registry.invalid');
    const segments = url.pathname.split('/').filter(Boolean);
    const read = method === 'GET' || method === 'HEAD';

    if (segments.length === 0) {
      throw RegistryHttpError(404, 'Not found');
    }
    if (segments[0] === '-') {
      if (read && segments[1] === 'ping' && segments.length === 2) {
        return { status: sendJson(request, response, 200, {}) };
      }
      if (read && segments[1] === 'whoami' && segments.length === 2) {
        const grant = grants.authenticate(bearerOf(request));
        if (!grant) {
          throw RegistryHttpError(401, 'Authentication required');
        }
        return {
          status: sendJson(request, response, 200, { username: grant.subject }),
          subject: grant.subject,
        };
      }
      if (segments[1] === 'package' && segments.length >= 4) {
        const { name, rest } = splitPackagePath(segments.slice(2));
        if (rest[0] !== 'dist-tags' || rest.length > 2) {
          throw RegistryHttpError(404, 'Not found');
        }
        const tag =
          rest[1] === undefined ? undefined : decodeSegment(rest[1], 'tag');
        if (read) {
          const tags = await registry.getDistTags(name);
          if (tag === undefined) {
            return { status: sendJson(request, response, 200, tags) };
          }
          // The tag comes from the URL; never follow the prototype chain.
          if (!Object.hasOwn(tags, tag)) {
            throw RegistryHttpError(404, `Tag ${tag} not found`);
          }
          return { status: sendJson(request, response, 200, tags[tag]) };
        }
        if (method === 'PUT' && tag !== undefined) {
          const grant = grants.authenticate(bearerOf(request));
          if (!grant) {
            throw RegistryHttpError(401, 'Authentication required to tag');
          }
          const body = await readJsonBody(request, 4096);
          const result = registry.setDistTag(grant, name, tag, body);
          return {
            status: sendJson(request, response, 201, { ok: true, ...result }),
            subject: grant.subject,
          };
        }
        throw RegistryHttpError(405, 'Dist-tags advance; they are not removed');
      }
      throw RegistryHttpError(
        404,
        'Not supported by this development registry',
      );
    }

    const { name, rest } = splitPackagePath(segments);
    if (rest.length === 0) {
      if (read) {
        const abbreviated = (request.headers.accept ?? '').includes(INSTALL_V1);
        const packument = await registry.getPackument(name, { abbreviated });
        return {
          status: sendJson(
            request,
            response,
            200,
            packument,
            abbreviated ? INSTALL_V1 : 'application/json',
          ),
        };
      }
      if (method === 'PUT') {
        const grant = grants.authenticate(bearerOf(request));
        if (!grant) {
          throw RegistryHttpError(401, 'Authentication required to publish');
        }
        const document = await readJsonBody(request, maxBodyBytes);
        const result = await registry.publish(grant, name, document);
        return {
          status: sendJson(request, response, result.created ? 201 : 200, {
            ok: true,
            id: name,
            ...result,
          }),
          subject: grant.subject,
        };
      }
      throw RegistryHttpError(405, 'Unpublish is not supported');
    }
    if (rest.length === 1 && read) {
      const manifest = await registry.getVersionManifest(
        name,
        decodeSegment(rest[0], 'version'),
      );
      return { status: sendJson(request, response, 200, manifest) };
    }
    if (rest.length === 2 && rest[0] === '-' && read) {
      const { bytes, tarballHash } = await registry.getTarball(
        name,
        decodeSegment(rest[1], 'tarball name'),
      );
      const etag = `"${tarballHash}"`;
      if (request.headers['if-none-match'] === etag) {
        response.writeHead(304, { etag });
        response.end();
        return { status: 304 };
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bytes.byteLength,
        'cache-control': 'public, max-age=31536000, immutable',
        etag,
      });
      response.end(method === 'HEAD' ? undefined : bytes);
      return { status: 200 };
    }
    if (!read) {
      throw RegistryHttpError(
        405,
        'Not supported by this development registry',
      );
    }
    throw RegistryHttpError(404, 'Not found');
  };

  /**
   * @param {IncomingMessage} request
   * @param {ServerResponse} response
   */
  const handle = async (request, response) => {
    const started = Date.now();
    /** @type {{ status: number, subject?: string }} */
    let outcome;
    try {
      outcome = await route(request, response);
    } catch (error) {
      const status = isRegistryHttpError(error) ? error.statusCode : 500;
      const reason = isRegistryHttpError(error)
        ? error.reason
        : 'Internal registry error';
      if (!isRegistryHttpError(error)) {
        console.error(error);
      }
      if (!response.headersSent) {
        const body = Buffer.from(
          JSON.stringify({ error: STATUS_ERRORS[status] ?? 'error', reason }),
        );
        response.writeHead(status, {
          'content-type': 'application/json',
          'content-length': body.length,
          'cache-control': 'no-store',
        });
        response.end(request.method === 'HEAD' ? undefined : body);
      } else {
        response.destroy();
      }
      outcome = { status };
    }
    log({
      method: request.method ?? 'GET',
      path: new URL(request.url ?? '/', 'http://registry.invalid').pathname,
      status: outcome.status,
      ms: Date.now() - started,
      ...(outcome.subject ? { subject: outcome.subject } : {}),
    });
  };

  return harden(handle);
};
harden(makeRequestHandler);
