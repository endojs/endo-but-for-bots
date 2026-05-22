// @ts-check
/* global globalThis */
/**
 * @import {
 *   BrokerRequest,
 *   BrokerResponse,
 *   Credentials,
 * } from '../../protocol.types.js'
 */

import net from 'node:net';
import { readFile, unlink, chmod } from 'node:fs/promises';

/**
 * Credential broker daemon (DESIGN.md §5.5).
 *
 * Loads the long-lived Anthropic credential at startup, then accepts
 * newline-delimited JSON requests over a UDS. Per-session state is
 * tracked in memory only.
 *
 * v1: API key mode. OAuth + preemptive rotation is left as roadmap;
 * to test the wire path *before* a real OAuth refresher lands, the
 * caller may pass `rotatePolicy(sessionId, currentApiKey)` returning
 * `{ apiKey }` (a fresh credentials payload) or `null` (no rotation
 * needed). The default keeps the v1 "never rotate" contract.
 *
 * @param {{
 *   socketPath: string,
 *   apiKey: string,
 *   rotatePolicy?: (sessionId: string, currentApiKey: string) => Credentials | null,
 * }} opts
 */
export const makeBroker = ({ socketPath, apiKey, rotatePolicy }) => {
  /** @type {Map<string, Credentials>} */
  const issued = new Map();
  let currentApiKey = apiKey;

  /**
   * @param {BrokerRequest} req
   * @returns {Promise<BrokerResponse>}
   */
  const handle = async req => {
    switch (req.type) {
      case 'issue': {
        /** @type {Credentials} */
        const creds = harden({ apiKey: currentApiKey });
        issued.set(req.sessionId, creds);
        return { type: 'creds', credentials: creds };
      }
      case 'revoke': {
        issued.delete(req.sessionId);
        return { type: 'ok' };
      }
      case 'rotate_if_needed': {
        const next = rotatePolicy
          ? rotatePolicy(req.sessionId, currentApiKey)
          : null;
        if (next === null || next === undefined) {
          return { type: 'noop' };
        }
        if (
          typeof next !== 'object' ||
          typeof next.apiKey !== 'string' ||
          next.apiKey.length === 0
        ) {
          return {
            type: 'error',
            message: 'rotatePolicy must return { apiKey } or null',
          };
        }
        currentApiKey = next.apiKey;
        const creds = harden({ apiKey: currentApiKey });
        if (issued.has(req.sessionId)) issued.set(req.sessionId, creds);
        return { type: 'creds', credentials: creds };
      }
      default: {
        return {
          type: 'error',
          message: `unknown broker request type: ${/** @type {any} */ (req).type}`,
        };
      }
    }
  };

  return harden({
    async listen() {
      await unlink(socketPath).catch(() => {});
      const server = net.createServer(conn => {
        let buf = '';
        conn.on('data', chunk => {
          buf += chunk.toString('utf8');
          for (;;) {
            const i = buf.indexOf('\n');
            if (i < 0) break;
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            // Parse the request inside the try/catch chain rather than
            // as an argument: a non-JSON line throws synchronously and
            // would otherwise tear down the `'data'` listener and kill
            // the broker process. Reply with `{type: 'error'}` and keep
            // serving.
            Promise.resolve(line)
              .then(raw =>
                handle(/** @type {BrokerRequest} */ (JSON.parse(raw))),
              )
              .then(res => conn.write(`${JSON.stringify(res)}\n`))
              .catch(e => {
                const msg = /** @type {Error} */ (e).message;
                conn.write(
                  `${JSON.stringify({ type: 'error', message: msg })}\n`,
                );
              });
          }
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve(undefined));
      });
      // 0600 — only the orchestrator UID may connect.
      await chmod(socketPath, 0o600);
      return server;
    },
  });
};
harden(makeBroker);

/**
 * Load the API key from a config file (mode 0600 expected) or env var.
 *
 * @param {{ configPath?: string, envVar?: string }} opts
 * @returns {Promise<string>}
 */
export const loadApiKey = async ({
  configPath,
  envVar = 'ANTHROPIC_API_KEY',
}) => {
  // eslint-disable-next-line no-restricted-globals
  const fromEnv = /** @type {any} */ (globalThis).process?.env?.[envVar];
  if (fromEnv) return fromEnv;
  if (configPath) {
    const data = await readFile(configPath, 'utf8');
    const trimmed = data.trim();
    if (trimmed.length === 0)
      throw new Error(`Empty broker config: ${configPath}`);
    return trimmed;
  }
  throw new Error(
    `No API key available. Set ${envVar} or supply a config file path.`,
  );
};
harden(loadApiKey);
