// @ts-check
/**
 * The gateway from a test's side (M3 W3.7; designs/m3-interfaces.md 12,
 * 17): serve it on a served state, read its sign-in secret the way
 * `scripts/gateway.mjs url` does, and connect Node CapTP clients over a
 * real loopback WebSocket (Node's built-in `WebSocket` with an `Origin`
 * header, binary frames), as a page does.
 *
 * `serveGateway(state, options?)` answers `{ url, origin, port, secret,
 * admin, status, connect(options?) }`; `connect()` answers a signed-in
 * client (`client.powers` is its `GatewayPowers`; W3.8's
 * `startBrowserGateway` hands this on), `connect({ signIn: false })` one
 * that has only called `CTP_BOOTSTRAP` (`client.signIn(secret?)` calls
 * `fetch`).
 *
 * The secrets wrapping key must be outside the state directory and the
 * user's own configuration: call `useTestWrappingKey(t)` before the
 * supervisor starts (its child processes inherit
 * `THIX_HARNESS_SECRETS_KEY`, `scripts/serve.mjs` allowlist).
 *
 * The importer must have installed the guest prelude first.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import { E } from '@endo/far';

import { gatewayUrl } from '../../scripts/gateway.mjs';
import { names } from '../../scripts/provision-steps.js';
import { makeClient } from '../adapter/_m3-captp-client.js';
import { tmpRoot } from '../template/index.js';

/**
 * Point `THIX_HARNESS_SECRETS_KEY` at a fresh file under the harness's
 * `tmp/`. Call before starting the supervisor; call the answer's `remove()`
 * when the last supervisor of the file has stopped (a restart reads it).
 * @param {string} [tag]
 */
export const useTestWrappingKey = (tag = 'm3') => {
  const dir = path.join(tmpRoot, `${tag}-key-${process.pid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.THIX_HARNESS_SECRETS_KEY = path.join(dir, 'secrets.key');
  return {
    file: process.env.THIX_HARNESS_SECRETS_KEY,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
};

/** A TCP port free on 127.0.0.1 now (for a test that needs a fixed port). */
export const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (
        server.address()
      );
      server.close(() => resolve(port));
    });
  });

/**
 * The `GatewayAdmin` and `Operator` of a served state (fresh presences:
 * call again after a restart).
 * @param {{ client: any }} state
 */
export const gatewayAdminOf = async state => {
  const agentHost = await state.client.call('lookup', names.agentHost);
  const harness = await state.client.call('lookup', names.harness);
  const [admin, operator] = await Promise.all([
    E(agentHost).gateway(),
    E(harness).getOperator(),
  ]);
  return { admin, operator };
};

/**
 * The secret in a sign-in URL's fragment.
 * @param {string} signInUrl
 */
export const secretOf = signInUrl =>
  new URLSearchParams(new URL(signInUrl).hash.slice(1)).get('agent') ?? '';

/**
 * Read the sign-in URL of a state (as `scripts/gateway.mjs url`).
 * @param {string} root
 * @param {string} origin
 */
export const readSignIn = async (root, origin) => {
  const signInUrl = await gatewayUrl({ state: root, origin });
  return { url: signInUrl, secret: secretOf(signInUrl) };
};

/**
 * @typedef {object} GatewayClient
 * @property {any} ws the WebSocket
 * @property {any} bootstrap the `GatewayBootstrap` presence
 * @property {(secret?: string) => Promise<any>} signIn `fetch`; answers the powers
 * @property {any} [powers] after `serveGateway`'s `connect()`: the powers
 * @property {Promise<{ code: number, reason: string }>} closed
 * @property {(code?: number) => void} close
 * @property {() => { held: number, peak: number }} answers questions asked
 *   and not dropped (the gateway's answer table holds at most these)
 * @property {() => void} resetAnswersPeak
 */

/**
 * Open one WebSocket and CapTP connection to a gateway.
 * @param {object} options
 * @param {number} options.port
 * @param {string} options.origin the `Origin` header
 * @param {string} [options.secret] the default of `signIn()`
 * @param {Record<string, string>} [options.headers] more upgrade headers
 *   (`X-Forwarded-For`)
 * @returns {Promise<GatewayClient>}
 */
export const connectGateway = async ({
  port,
  origin,
  secret,
  headers = {},
}) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    // @ts-expect-error undici's WebSocketInit accepts headers
    headers: { Origin: origin, ...headers },
  });
  ws.binaryType = 'arraybuffer';
  /** @type {Promise<{ code: number, reason: string }>} */
  const closed = new Promise(resolve => {
    ws.onclose = event => resolve({ code: event.code, reason: event.reason });
  });
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(Error('the WebSocket did not open'));
  });
  const client = makeClient({
    send: bytes => ws.send(/** @type {Uint8Array<ArrayBuffer>} */ (bytes)),
  });
  ws.onmessage = event => client.receive(new Uint8Array(event.data));
  void closed.then(() => client.close());
  const bootstrap = client.bootstrap();
  return {
    ws,
    bootstrap,
    signIn: (given = secret) => E(bootstrap).fetch(given),
    closed,
    close: (code = 1000) => ws.close(code),
    answers: client.answers,
    resetAnswersPeak: client.resetAnswersPeak,
  };
};

/**
 * Serve the gateway on a served state (`startFromTemplate`'s state) and
 * read its secret.
 * @param {{ client: any, root: string }} state
 * @param {object} [options]
 * @param {number} [options.port] default 0 (ephemeral)
 * @param {string} [options.publicOrigin]
 * @param {string[]} [options.trustedProxies]
 * @param {number} [options.signInFailuresPerMinute]
 */
export const serveGateway = async (state, options = {}) => {
  const { admin, operator } = await gatewayAdminOf(state);
  const status = await E(admin).serve(
    harden({ port: 0, ...options, operator }),
  );
  if (status.state !== 'serving')
    throw Error(`the gateway did not serve: ${JSON.stringify(status)}`);
  const { url, secret } = await readSignIn(state.root, status.origin);
  return {
    url,
    origin: status.origin,
    port: status.port,
    secret,
    admin,
    operator,
    status,
    /**
     * @param {{ origin?: string, secret?: string, headers?: Record<string, string>, signIn?: boolean }} [more]
     * @returns {Promise<GatewayClient>}
     */
    connect: async (more = {}) => {
      const client = await connectGateway({
        port: status.port,
        origin: more.origin ?? status.origin,
        secret: more.secret ?? secret,
        ...(more.headers === undefined ? {} : { headers: more.headers }),
      });
      if (more.signIn === false) return client;
      return { ...client, powers: await client.signIn() };
    },
  };
};
