// @ts-check

// A minimal fetch-shaped HTTP transport over node:http/node:https,
// covering exactly what the Privacy client needs: method, headers,
// string body, and a response with { ok, status, json() }.
//
// It exists to keep undici (Node's global fetch) out of the caplet's
// worker: on Node 24 under SES lockdown, undici's client-teardown
// path mutates a shared ClientDestroyedError that the lockdown's
// unhandled-rejection reporting has already hardened, spraying
// TypeError unhandled rejections. Plain node:http with per-request
// Connection: close has no pooled state to tear down.

import http from 'node:http';
import https from 'node:https';

// A server that accepts the connection but never responds would
// otherwise leave the promise unsettled forever — and since budget
// mutations serialize through the account mutex, one hung request
// would deadlock every future mutation on the account.
export const DEFAULT_TIMEOUT_MS = 30_000;
harden(DEFAULT_TIMEOUT_MS);

/**
 * Satisfies the client's `FetchLike` contract (see client.js), plus
 * `text()` for callers that relay raw bodies and a `timeoutMs`
 * inactivity bound.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>,
 *   body?: string, timeoutMs?: number }} [init]
 * @returns {Promise<{ ok: boolean, status: number,
 *   json(): Promise<any>, text(): Promise<string> }>}
 */
export const nodeFetch = (
  url,
  { method = 'GET', headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const request = transport.request(
      target,
      {
        method,
        headers: { ...headers, Connection: 'close' },
      },
      response => {
        response.setEncoding('utf-8');
        let text = '';
        response.on('data', chunk => {
          text += chunk;
        });
        response.on('end', () => {
          const status = response.statusCode || 0;
          resolve(
            harden({
              ok: status >= 200 && status < 300,
              status,
              json: async () => JSON.parse(text),
              text: async () => text,
            }),
          );
        });
        response.on('error', reject);
      },
    );
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => {
      request.destroy(
        new Error(`request timed out after ${timeoutMs}ms of inactivity`),
      );
    });
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
harden(nodeFetch);
