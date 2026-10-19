// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import http from 'node:http';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import {
  mainHttp,
  makeMcpHttpHandler,
  parseBearer,
  startMcpHttpGateway,
} from '../src/http.js';
import { makeAgentTools } from '../src/agent-interface.js';

const FORMULA_ID = 'ab'.repeat(32);
const OTHER_ID = 'cd'.repeat(32);
const HOST_ID = 'ef'.repeat(32);
const NODE = '12'.repeat(32);

// A node:http client with keep-alive disabled (`agent: false`), shaped
// like the slice of `fetch` these tests use. The global `fetch` (undici)
// pools keep-alive sockets against the gateway; closing the gateway in
// teardown then rejects them with a `ClientDestroyedError`, which SES
// surfaces as a fatal unhandled rejection on Node 24.
/**
 * @param {string | URL} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string }} [init]
 */
const httpRequest = (url, { method = 'GET', headers = {}, body } = {}) =>
  /** @type {Promise<{ status: number, headers: { get: (name: string) => string | undefined }, text: () => Promise<string>, json: () => Promise<any> }>} */ (
    new Promise((resolve, reject) => {
      const request = http.request(
        url,
        { method, headers, agent: false },
        response => {
          let text = '';
          response.setEncoding('utf-8');
          response.on('data', chunk => {
            text += chunk;
          });
          response.on('end', () =>
            resolve({
              status: response.statusCode || 0,
              headers: {
                get: name => {
                  const value = response.headers[name.toLowerCase()];
                  return Array.isArray(value) ? value.join(', ') : value;
                },
              },
              text: async () => text,
              json: async () => JSON.parse(text),
            }),
          );
        },
      );
      request.on('error', reject);
      request.end(body);
    })
  );

/**
 * A fake daemon facet: an exo whose methods take and return passables.
 *
 * @param {string} name
 * @param {Record<string, (...methodArguments: any[]) => any>} methods
 */
const makeFake = (name, methods) =>
  makeExo(
    name,
    M.interface(name, {}, { defaultGuards: 'passable' }),
    /** @type {any} */ (methods),
  );

const makeFakeGuest = (label, calls) =>
  makeFake('EndoGuest', {
    help: () => `help for ${label}`,
    has: (...path) => {
      calls.push([label, 'has', path]);
      return path[0] === 'present';
    },
    list: () => ['present'],
    remove: () => {},
    move: () => {},
    copy: () => {},
    makeDirectory: () => {},
    readText: path => {
      calls.push([label, 'readText', path]);
      throw Error(`Unknown pet name: ${path.join('/')}`);
    },
    writeText: () => {},
    listMessages: () => [],
    send: () => {},
    reply: () => {},
    adopt: () => {},
    dismiss: n => {
      calls.push([label, 'dismiss', n]);
    },
    request: () => new Promise(() => {}),
    define: (...defineArguments) => {
      calls.push([label, 'define', defineArguments]);
    },
    // An empty stream: a read ends at once, whatever its wait.
    followNameChanges: () =>
      readerFromIterator(
        (async function* empty() {
          // Yields nothing.
        })(),
      ),
  });

/**
 * @param {object} [options]
 * @param {number} [options.penaltyMs]
 * @param {string[]} [options.allowedOrigins]
 */
const startGateway = async ({ penaltyMs = 0, allowedOrigins } = {}) => {
  /** @type {unknown[][]} */
  const calls = [];
  const closed = makePromiseKit();
  /** @type {Record<string, unknown>} */
  const facets = {
    [FORMULA_ID]: makeFakeGuest('mine', calls),
    [OTHER_ID]: makeFakeGuest('other', calls),
  };
  const host = makeFake('EndoHost', {
    identify: name =>
      name === '@agent' ? `${'00'.repeat(32)}:${NODE}` : undefined,
    lookupById: qualified => {
      const [id, node] = qualified.split(':');
      if (node !== NODE) throw Error('Unknown node');
      calls.push(['host', 'lookupById', id]);
      if (id === HOST_ID) return host;
      if (!Object.hasOwn(facets, id)) throw Error('Unknown formula');
      return facets[id];
    },
  });
  facets[HOST_ID] = host;
  const gateway = startMcpHttpGateway({
    connection: {
      host,
      closed: closed.promise,
      close: () => closed.resolve(undefined),
    },
    version: '0.0.0',
    port: 0,
    penaltyMs,
    allowedOrigins,
  });
  const url = await gateway.started;
  let nextId = 1;
  /**
   * @param {string} method
   * @param {unknown} [params]
   * @param {object} [options]
   * @param {string} [options.bearer]
   */
  const rpc = async (method, params, { bearer = FORMULA_ID } = {}) => {
    const id = nextId;
    nextId += 1;
    const response = await httpRequest(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { url, rpc, calls, close: gateway.close };
};

test('the handler refuses a body longer than maxBodyBytes', async t => {
  // Driven without a socket: over a real connection the server's early
  // refusal races the client's upload, which surfaces as a client-side
  // error rather than the 413.
  /** @type {string[]} */
  const handled = [];
  const handler = makeMcpHttpHandler({
    resolveServer: async () => ({
      handleLine: async line => {
        handled.push(line);
        return undefined;
      },
    }),
    maxBodyBytes: 8,
  });
  const request = /** @type {any} */ ({
    url: '/mcp',
    method: 'POST',
    headers: {
      authorization: `Bearer ${FORMULA_ID}`,
      'content-type': 'application/json',
    },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from('{"jsonrp');
      yield Buffer.from('c":"2.0"}');
    },
  });
  /** @type {{ status?: number, body?: string }} */
  const sent = {};
  const response = /** @type {any} */ ({
    writeHead: status => {
      sent.status = status;
    },
    end: body => {
      sent.body = body;
    },
  });
  t.true(await handler(request, response));
  t.is(sent.status, 413);
  t.deepEqual(JSON.parse(sent.body || ''), {
    error: 'Request body too large',
  });
  t.deepEqual(handled, []);
});

test('parseBearer accepts only a formula identifier', t => {
  t.is(parseBearer(`Bearer ${FORMULA_ID}`), FORMULA_ID);
  t.is(parseBearer(`bearer ${FORMULA_ID}:${NODE}`), `${FORMULA_ID}:${NODE}`);
  t.is(parseBearer(undefined), undefined);
  t.is(parseBearer(FORMULA_ID), undefined);
  t.is(parseBearer(`Bearer ${FORMULA_ID.toUpperCase()}`), undefined);
  t.is(parseBearer(`Bearer ${FORMULA_ID.slice(1)}`), undefined);
  t.is(parseBearer(`Basic ${FORMULA_ID}`), undefined);
});

test.serial(
  'a bearer selects its guest for initialize, tools/list, and tools/call',
  async t => {
    const { url, rpc, calls, close } = await startGateway();
    t.true(url.endsWith('/mcp'));
    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
      t.is(init.status, 200);
      t.is(init.body.result.serverInfo.name, 'endo');
      t.deepEqual(init.body.result.capabilities.tools, { listChanged: false });

      const list = await rpc('tools/list');
      t.deepEqual(
        list.body.result.tools.map(({ name }) => name),
        makeAgentTools().map(({ name }) => name),
      );

      const has = await rpc('tools/call', {
        name: 'has',
        arguments: { petNamePath: ['present'] },
      });
      t.deepEqual(has.body.result, {
        content: [{ type: 'text', text: 'true' }],
      });

      await rpc(
        'tools/call',
        { name: 'has', arguments: { petNamePath: ['present'] } },
        { bearer: OTHER_ID },
      );
      t.deepEqual(
        calls.filter(([label]) => label !== 'host'),
        [
          ['mine', 'has', ['present']],
          ['other', 'has', ['present']],
        ],
      );
      // Each guest is resolved once and then reused.
      t.deepEqual(
        calls.filter(([label]) => label === 'host').map(([, , id]) => id),
        [FORMULA_ID, OTHER_ID],
      );

      // An unknown method is a JSON-RPC error on a successful exchange.
      const unknown = await rpc('resources/list');
      t.is(unknown.status, 200);
      t.is(unknown.body.error.code, -32_601);
    } finally {
      await close();
    }
  },
);

test.serial(
  'authentication failures are indistinguishable and rate limited',
  async t => {
    const { url, rpc, close } = await startGateway({ penaltyMs: 60_000 });
    try {
      const missing = await httpRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      t.is(missing.status, 401);
      t.is(missing.headers.get('www-authenticate'), 'Bearer');
      // The limiter now refuses every attempt from this address, even a good
      // bearer, until the penalty lapses.
      const limited = await rpc('ping');
      t.is(limited.status, 429);
    } finally {
      await close();
    }

    const fresh = await startGateway();
    try {
      const unknown = await fresh.rpc('ping', undefined, {
        bearer: '99'.repeat(32),
      });
      const hostFacet = await fresh.rpc('ping', undefined, { bearer: HOST_ID });
      const malformed = await fresh.rpc('ping', undefined, { bearer: 'nope' });
      t.is(unknown.status, 401);
      t.deepEqual(hostFacet, unknown);
      t.deepEqual(malformed, unknown);
      // A failed resolution is not cached: the good bearer still works.
      const ok = await fresh.rpc('ping');
      t.is(ok.status, 200);
    } finally {
      await fresh.close();
    }
  },
);

test.serial(
  'the transport refuses what a stateless JSON endpoint does not serve',
  async t => {
    const { url, close } = await startGateway({
      allowedOrigins: ['https://chat.example'],
    });
    const headers = {
      Authorization: `Bearer ${FORMULA_ID}`,
      'Content-Type': 'application/json',
    };
    try {
      const get = await httpRequest(url, {
        headers: { ...headers, Accept: 'text/event-stream' },
      });
      t.is(get.status, 405);
      t.is(get.headers.get('allow'), 'POST');

      const other = await httpRequest(new URL('/elsewhere', url), {
        method: 'POST',
        headers,
        body: '{}',
      });
      t.is(other.status, 404);

      const foreign = await httpRequest(url, {
        method: 'POST',
        headers: { ...headers, Origin: 'https://evil.example' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      t.is(foreign.status, 403);
      const allowed = await httpRequest(url, {
        method: 'POST',
        headers: { ...headers, Origin: 'https://chat.example' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      t.is(allowed.status, 200);

      const notification = await httpRequest(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      });
      t.is(notification.status, 202);
      t.is(await notification.text(), '');

      const garbled = await httpRequest(url, {
        method: 'POST',
        headers,
        body: '{',
      });
      t.is(garbled.status, 400);
      t.is((await garbled.json()).error.code, -32_700);

      const batch = await httpRequest(url, {
        method: 'POST',
        headers,
        body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
      });
      t.is(batch.status, 400);
      t.is((await batch.json()).error.code, -32_600);

      const text = await httpRequest(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'text/plain' },
        body: '{}',
      });
      t.is(text.status, 415);
    } finally {
      await close();
    }
  },
);

test.serial(
  'mainHttp serves until stopped, and exits 1 when the daemon drops',
  async t => {
    /** @type {string[]} */
    const lines = [];
    const stop = makePromiseKit();
    const closed = makePromiseKit();
    const exit = mainHttp({
      env: { ENDO_MCP_HTTP_PORT: '0' },
      connect: async () => ({
        host: makeFake('EndoHost', {}),
        closed: closed.promise,
        close: () => {},
      }),
      log: line => lines.push(line),
      version: '0.0.0',
      stop: stop.promise,
    });
    while (lines.length === 0) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 5));
    }
    t.regex(
      lines[0],
      /^Endo MCP gateway listening on http:\/\/127\.0\.0\.1:\d+\/mcp$/,
    );
    stop.resolve(undefined);
    t.is(await exit, 0);

    const dropped = mainHttp({
      env: { ENDO_MCP_HTTP_PORT: '0', ENDO_MCP_HTTP_HOST: '0.0.0.0' },
      connect: async () => ({
        host: makeFake('EndoHost', {}),
        closed: closed.promise,
        close: () => {},
      }),
      log: line => lines.push(line),
      version: '0.0.0',
    });
    closed.resolve(undefined);
    t.is(await dropped, 1);
    t.true(lines.some(line => line.startsWith('WARNING:')));

    t.is(
      await mainHttp({
        env: { ENDO_MCP_HTTP_PORT: 'eighty' },
        connect: async () => t.fail('must not connect'),
        log: line => lines.push(line),
        version: '0.0.0',
      }),
      2,
    );
  },
);
