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
 * @param {IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<any>}
 */
const readJsonBody = async (req, maxBytes) => {
  const declared = Number(req.headers['content-length']);
  if (declared > maxBytes) {
    throw RegistryHttpError(413, 'Request body exceeds the size limit');
  }
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
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
 * @param {IncomingMessage} req
 * @returns {string | undefined}
 */
const bearerOf = req => {
  const header = req.headers.authorization;
  const match = header && /^Bearer\s+(\S+)$/iu.exec(header);
  return match ? match[1] : undefined;
};

/**
 * The npm registry HTTP surface of `designs/npm-dev-registry-serving.md`
 * § npm registry HTTP surface. Reads are public; mutations authenticate a
 * `PublishGrant` bearer. The adapter trusts no forwarded identity header,
 * and never logs Authorization.
 *
 * @param {object} options
 * @param {Registry} options.registry
 * @param {Grants} options.grants
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
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {number} status
   * @param {unknown} value
   * @param {string} [contentType]
   */
  const sendJson = (req, res, status, value, contentType) => {
    const body = Buffer.from(JSON.stringify(value));
    const etag = `"${createHash('sha256').update(body).digest('base64url')}"`;
    if (status === 200 && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache' });
      res.end();
      return 304;
    }
    res.writeHead(status, {
      'content-type': contentType ?? 'application/json',
      'content-length': body.length,
      'cache-control': 'no-cache',
      etag,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return status;
  };

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @returns {Promise<{ status: number, subject?: string }>}
   */
  const route = async (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://registry.invalid');
    const segments = url.pathname.split('/').filter(Boolean);
    const read = method === 'GET' || method === 'HEAD';

    if (segments.length === 0) {
      throw RegistryHttpError(404, 'Not found');
    }
    if (segments[0] === '-') {
      if (read && segments[1] === 'ping' && segments.length === 2) {
        return { status: sendJson(req, res, 200, {}) };
      }
      if (read && segments[1] === 'whoami' && segments.length === 2) {
        const grant = grants.authenticate(bearerOf(req));
        if (!grant) {
          throw RegistryHttpError(401, 'Authentication required');
        }
        return {
          status: sendJson(req, res, 200, { username: grant.subject }),
          subject: grant.subject,
        };
      }
      if (segments[1] === 'package' && segments.length >= 4) {
        const { name, rest } = splitPackagePath(segments.slice(2));
        if (rest[0] !== 'dist-tags' || rest.length > 2) {
          throw RegistryHttpError(404, 'Not found');
        }
        const tag =
          rest[1] === undefined ? undefined : decodeURIComponent(rest[1]);
        if (read) {
          const tags = await registry.getDistTags(name);
          if (tag === undefined) {
            return { status: sendJson(req, res, 200, tags) };
          }
          if (tags[tag] === undefined) {
            throw RegistryHttpError(404, `Tag ${tag} not found`);
          }
          return { status: sendJson(req, res, 200, tags[tag]) };
        }
        if (method === 'PUT' && tag !== undefined) {
          const grant = grants.authenticate(bearerOf(req));
          const body = await readJsonBody(req, 4096);
          const result = registry.setDistTag(grant, name, tag, body);
          return {
            status: sendJson(req, res, 201, { ok: true, ...result }),
            subject: grant?.subject,
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
        const abbreviated = (req.headers.accept ?? '').includes(INSTALL_V1);
        const packument = await registry.getPackument(name, { abbreviated });
        return {
          status: sendJson(
            req,
            res,
            200,
            packument,
            abbreviated ? INSTALL_V1 : 'application/json',
          ),
        };
      }
      if (method === 'PUT') {
        const grant = grants.authenticate(bearerOf(req));
        if (!grant) {
          throw RegistryHttpError(401, 'Authentication required to publish');
        }
        const document = await readJsonBody(req, maxBodyBytes);
        const result = await registry.publish(grant, name, document);
        return {
          status: sendJson(req, res, result.created ? 201 : 200, {
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
        decodeURIComponent(rest[0]),
      );
      return { status: sendJson(req, res, 200, manifest) };
    }
    if (rest.length === 2 && rest[0] === '-' && read) {
      const { bytes, tarballHash } = await registry.getTarball(
        name,
        decodeURIComponent(rest[1]),
      );
      const etag = `"${tarballHash}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { etag });
        res.end();
        return { status: 304 };
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': bytes.byteLength,
        'cache-control': 'public, max-age=31536000, immutable',
        etag,
      });
      res.end(method === 'HEAD' ? undefined : bytes);
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
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   */
  const handle = async (req, res) => {
    const started = Date.now();
    /** @type {{ status: number, subject?: string }} */
    let outcome;
    try {
      outcome = await route(req, res);
    } catch (error) {
      const status = isRegistryHttpError(error) ? error.statusCode : 500;
      const reason = isRegistryHttpError(error)
        ? error.reason
        : 'Internal registry error';
      if (!isRegistryHttpError(error)) {
        console.error(error);
      }
      if (!res.headersSent) {
        const body = Buffer.from(
          JSON.stringify({ error: STATUS_ERRORS[status] ?? 'error', reason }),
        );
        res.writeHead(status, {
          'content-type': 'application/json',
          'content-length': body.length,
          'cache-control': 'no-store',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      } else {
        res.destroy();
      }
      outcome = { status };
    }
    log({
      method: req.method ?? 'GET',
      path: new URL(req.url ?? '/', 'http://registry.invalid').pathname,
      status: outcome.status,
      ms: Date.now() - started,
      ...(outcome.subject ? { subject: outcome.subject } : {}),
    });
  };

  return handle;
};
harden(makeRequestHandler);
