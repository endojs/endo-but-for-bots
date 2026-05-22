// @ts-check
/* global Buffer */
/**
 * @import {
 *   CreateSessionRequest,
 *   Session,
 *   SessionSummary,
 * } from '../../protocol.types.js'
 */

import http from 'node:http';
import { unlink, chmod } from 'node:fs/promises';

// Defense-in-depth: the API socket is 0600 so only the orchestrator's
// own UID can connect, but trusting in-process callers to send
// well-formed bodies is still a footgun. A buggy or compromised
// factory could otherwise drive unbounded memory growth here.
// 256 KiB is comfortably larger than a CreateSessionRequest in any
// realistic shape (vcpus / memMB / arch / network / credentials).
const MAX_BODY_BYTES = 256 * 1024;

// Allow-list scalar shapes we'll forward to createSession. Anything
// outside this surface is rejected at the boundary rather than
// trusting `createSession` to defend itself.
const ALLOWED_ARCHES = new Set(['x86_64', 'aarch64']);
const ALLOWED_NETWORKS = new Set(['egress', 'none']);
const ALLOWED_ATTACH_MODES = new Set(['stream', 'none']);

/**
 * Reject request bodies that aren't shaped like a `CreateSessionRequest`.
 * Strict enough to bounce obvious typos and hostile inputs, loose enough
 * to keep evolving fields working — anything not on the allow-list
 * passes through to be filtered downstream.
 *
 * @param {any} body
 * @returns {string | undefined}  error message, or undefined if OK
 */
const validateCreateSessionBody = body => {
  if (body === null || typeof body !== 'object')
    return 'body must be an object';
  if (body.arch !== undefined && !ALLOWED_ARCHES.has(body.arch)) {
    return `arch must be one of ${[...ALLOWED_ARCHES].join(', ')}`;
  }
  // `network` and `attachMode` are required. Empty / omitted bodies
  // used to flow through (because `readBody` returns `{}` on empty
  // input) and then the orchestrator would proceed with `undefined`
  // request fields. Reject at the boundary.
  if (!ALLOWED_NETWORKS.has(body.network)) {
    return `network must be one of ${[...ALLOWED_NETWORKS].join(', ')}`;
  }
  if (!ALLOWED_ATTACH_MODES.has(body.attachMode)) {
    return `attachMode must be one of ${[...ALLOWED_ATTACH_MODES].join(', ')}`;
  }
  if (body.resources !== undefined) {
    if (body.resources === null || typeof body.resources !== 'object') {
      return 'resources must be an object';
    }
    const { vcpus, memMB } = body.resources;
    if (vcpus !== undefined) {
      if (
        typeof vcpus !== 'number' ||
        !Number.isInteger(vcpus) ||
        vcpus < 1 ||
        vcpus > 32
      ) {
        return 'resources.vcpus must be an integer in [1, 32]';
      }
    }
    if (memMB !== undefined) {
      if (
        typeof memMB !== 'number' ||
        !Number.isInteger(memMB) ||
        memMB < 64 ||
        memMB > 65536
      ) {
        return 'resources.memMB must be an integer in [64, 65536]';
      }
    }
  }
  // The remaining BootConfig-bound fields. Without these checks an
  // invalid type would land in the persisted session and then
  // propagate into the agent's BootConfig (Copilot review round 3
  // #16).
  if (
    body.initialPrompt !== undefined &&
    typeof body.initialPrompt !== 'string'
  ) {
    return 'initialPrompt must be a string';
  }
  if (body.envExtra !== undefined) {
    if (
      body.envExtra === null ||
      typeof body.envExtra !== 'object' ||
      Array.isArray(body.envExtra)
    ) {
      return 'envExtra must be a plain object of string→string';
    }
    for (const [k, v] of Object.entries(body.envExtra)) {
      if (typeof k !== 'string' || k.length === 0) {
        return 'envExtra keys must be non-empty strings';
      }
      if (typeof v !== 'string') {
        return `envExtra[${JSON.stringify(k)}] must be a string`;
      }
    }
  }
  if (body.credentials !== undefined) {
    if (
      body.credentials === null ||
      typeof body.credentials !== 'object' ||
      Array.isArray(body.credentials) ||
      typeof body.credentials.apiKey !== 'string' ||
      body.credentials.apiKey.length === 0
    ) {
      return 'credentials must be { apiKey: <non-empty string> }';
    }
  }
  return undefined;
};

/**
 * HTTP/1.1 caller-facing API over a UDS (DESIGN.md §6.1).
 *
 * Endpoints:
 *   POST   /v1/sessions             -> Session
 *   GET    /v1/sessions             -> SessionSummary[]
 *   GET    /v1/sessions/:id         -> Session
 *   POST   /v1/sessions/:id/ready   -> 204
 *   DELETE /v1/sessions/:id         -> 204
 *
 * @typedef {object} ApiHandlers
 * @property {(req: CreateSessionRequest) => Promise<Session>} createSession
 * @property {() => SessionSummary[]} listSessions
 * @property {(id: string) => Session | undefined} getSession
 * @property {(id: string) => Promise<void>} markReady
 * @property {(id: string) => Promise<void>} terminateSession
 *
 * @param {{ socketPath: string, handlers: ApiHandlers }} opts
 */
export const makeApiServer = ({ socketPath, handlers }) => {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://unix');
      const parts = url.pathname.split('/').filter(Boolean);

      // POST /v1/sessions
      if (
        req.method === 'POST' &&
        parts.length === 2 &&
        parts[0] === 'v1' &&
        parts[1] === 'sessions'
      ) {
        let body;
        try {
          body = await readBody(req);
        } catch (e) {
          // Size cap throws a tagged Error; JSON.parse throws SyntaxError.
          // Map them to distinct status codes so callers can tell why the
          // request bounced.
          if (e instanceof SyntaxError) {
            respondJson(res, 400, { error: `invalid JSON: ${e.message}` });
          } else {
            respondJson(res, 413, { error: /** @type {Error} */ (e).message });
          }
          return;
        }
        const validationError = validateCreateSessionBody(body);
        if (validationError) {
          respondJson(res, 400, { error: validationError });
          return;
        }
        const session = await handlers.createSession(body);
        respondJson(res, 200, session);
        return;
      }

      // GET /v1/sessions
      if (
        req.method === 'GET' &&
        parts.length === 2 &&
        parts[0] === 'v1' &&
        parts[1] === 'sessions'
      ) {
        respondJson(res, 200, handlers.listSessions());
        return;
      }

      // GET /v1/sessions/:id
      if (
        req.method === 'GET' &&
        parts.length === 3 &&
        parts[0] === 'v1' &&
        parts[1] === 'sessions'
      ) {
        const session = handlers.getSession(parts[2]);
        if (!session) {
          respondJson(res, 404, { error: 'unknown session' });
          return;
        }
        respondJson(res, 200, session);
        return;
      }

      // POST /v1/sessions/:id/ready
      if (
        req.method === 'POST' &&
        parts.length === 4 &&
        parts[0] === 'v1' &&
        parts[1] === 'sessions' &&
        parts[3] === 'ready'
      ) {
        await handlers.markReady(parts[2]);
        res.writeHead(204);
        res.end();
        return;
      }

      // DELETE /v1/sessions/:id
      if (
        req.method === 'DELETE' &&
        parts.length === 3 &&
        parts[0] === 'v1' &&
        parts[1] === 'sessions'
      ) {
        await handlers.terminateSession(parts[2]);
        res.writeHead(204);
        res.end();
        return;
      }

      respondJson(res, 404, { error: 'not found' });
    } catch (e) {
      const err = /** @type {Error} */ (e);
      respondJson(res, 500, { error: err.message });
    }
  });

  return harden({
    async listen() {
      await unlink(socketPath).catch(() => {});
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve(undefined));
      });
      await chmod(socketPath, 0o600);
      return server;
    },
    async close() {
      await new Promise(resolve => server.close(() => resolve(undefined)));
    },
  });
};
harden(makeApiServer);

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
const readBody = async req => {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      // Stop draining — Node will continue to fill the socket buffer
      // but we won't allocate more from it. The 413 response above
      // handles the client side.
      throw new Error(
        `request body exceeds MAX_BODY_BYTES (${MAX_BODY_BYTES})`,
      );
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(text);
};

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} code
 * @param {any} body
 */
const respondJson = (res, code, body) => {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
};
