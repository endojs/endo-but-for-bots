// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

import {
  BRIDGE_DOWN,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  TOOL_NOT_PERMITTED,
  isConstructionError,
  makeConstructionError,
  makeMcpToolServer,
  makeToolCatalog,
  renderAllowedTools,
  renderToolResult,
} from '../src/adapters/mcp.js';

/** @import { ToolDeclaration } from '../src/types.js' */

/**
 * @param {string} name
 * @returns {ToolDeclaration<any>}
 */
const tool = name =>
  harden({
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    argumentsShape: M.splitRecord({}, { text: M.string() }),
    invoke: (target, { text }) => E(target)[name](text),
  });

/** @param {unknown} error */
const reasonOf = error => /** @type {any} */ (error).reason;

test('catalog: empty declaration is empty-interface', t => {
  const error = t.throws(() => makeToolCatalog([]));
  t.is(reasonOf(error), 'empty-interface');
});

test('construction errors are recognized by brand and hardened', t => {
  const cause = Error('underlying');
  const error = makeConstructionError('malformed-name', 'bad name', {
    names: ['foo__bar'],
    cause,
  });
  t.true(isConstructionError(error));
  t.true(Object.isFrozen(error));
  t.is(error.reason, 'malformed-name');
  t.deepEqual(error.names, ['foo__bar']);
  t.is(error.cause, cause);
  t.deepEqual(Object.keys(error), [], 'discriminants are not enumerable');
  const lookalike = Object.assign(Error('not ours'), {
    reason: 'empty-interface',
  });
  t.false(isConstructionError(lookalike));
  t.false(isConstructionError({ reason: 'empty-interface' }));
});

test('catalog: malformed, reserved, and dunder names are malformed-name', t => {
  for (const name of [
    'foo__bar',
    '__proto__',
    'constructor',
    '__getMethodNames__',
    'has space',
    'endo_readText',
    'Upper',
    '',
  ]) {
    const error = t.throws(() => makeToolCatalog([tool('ok'), tool(name)]), {
      message: /malformed/,
    });
    t.is(reasonOf(error), 'malformed-name', name);
  }
});

test('catalog: duplicate and case-confusable names are catalog-name-conflict', t => {
  for (const [a, b] of [
    ['readText', 'readText'],
    ['readText', 'readtext'],
  ]) {
    const error = t.throws(() => makeToolCatalog([tool(a), tool(b)]));
    t.is(reasonOf(error), 'catalog-name-conflict');
  }
});

test('catalog: evaluators are ordinary tool names', t => {
  const catalog = makeToolCatalog([tool('evaluate'), tool('define')]);
  t.deepEqual(catalog.names, ['evaluate', 'define']);
  t.deepEqual(catalog.warnings, []);
});

test('catalog: a caller-reserved name collision is a warning, not a throw', t => {
  const declarations = [tool('submit'), tool('readText')];
  t.deepEqual(makeToolCatalog(declarations).warnings, []);
  const catalog = makeToolCatalog(declarations, {
    advisoryReservedNames: ['submit'],
  });
  t.deepEqual(catalog.warnings, [
    { reason: 'reserved-name-collision', level: 'warning', names: ['submit'] },
  ]);
  t.deepEqual(catalog.names, ['submit', 'readText']);
});

test('catalog: allowed tools render under the fixed server label', t => {
  const catalog = makeToolCatalog([tool('readText'), tool('list')]);
  t.deepEqual(renderAllowedTools(catalog), [
    'mcp__endo__readText',
    'mcp__endo__list',
  ]);
  t.deepEqual(
    renderAllowedTools(catalog).map(entry => entry.replace('mcp__endo__', '')),
    catalog.tools.map(({ name }) => name),
  );
});

test('renderToolResult renders passables as text', t => {
  t.is(renderToolResult('hi'), 'hi');
  t.is(renderToolResult(undefined), '');
  t.is(renderToolResult(harden({ n: 5n })), '{\n  "n": "5"\n}');
  const remotable = makeExo('X', M.interface('X', {}), {});
  t.is(renderToolResult(harden([remotable])), '[\n  "[remotable]"\n]');
});

const GuestFixtureInterface = M.interface(
  'Guest',
  {},
  { defaultGuards: 'passable' },
);

/**
 * @param {object} [options]
 * @param {Promise<unknown>} [options.connectionClosed]
 * @param {Record<string, (...methodArguments: any[]) => any>} [options.methods]
 */
const makeFixture = ({ connectionClosed, methods = {} } = {}) => {
  /** @type {unknown[][]} */
  const calls = [];
  /** @type {object[]} */
  const notifications = [];
  const target = makeExo('Guest', GuestFixtureInterface, {
    echo: text => {
      calls.push(['echo', text]);
      return `echo:${text}`;
    },
    fail: () => {
      throw Error('no such file');
    },
    ...methods,
  });
  const catalog = makeToolCatalog([tool('echo'), tool('fail'), tool('hang')]);
  const server = makeMcpToolServer({
    catalog,
    target,
    serverInfo: { name: 'endo', version: '0.0.0' },
    connectionClosed,
    notify: message => notifications.push(message),
  });
  return { server, calls, notifications };
};

/**
 * @param {ReturnType<typeof makeFixture>['server']} server
 * @param {string} method
 * @param {unknown} [params]
 */
const request = (server, method, params) =>
  /** @type {Promise<any>} */ (
    server.handleMessage({ jsonrpc: '2.0', id: 1, method, params })
  );

test('initialize advertises static tools and logging', async t => {
  const { server } = makeFixture();
  const { result } = await request(server, 'initialize', {
    protocolVersion: '2025-06-18',
  });
  t.is(result.protocolVersion, '2025-06-18');
  t.deepEqual(result.serverInfo, { name: 'endo', version: '0.0.0' });
  t.deepEqual(result.capabilities, {
    tools: { listChanged: false },
    logging: {},
  });
});

test('tools/list returns exactly the static catalog', async t => {
  const { server } = makeFixture();
  const { result } = await request(server, 'tools/list');
  t.deepEqual(
    result.tools.map(({ name }) => name),
    ['echo', 'fail', 'hang'],
  );
});

test('tools/call reaches the bound target', async t => {
  const { server, calls } = makeFixture();
  const { result } = await request(server, 'tools/call', {
    name: 'echo',
    arguments: { text: 'hi' },
  });
  t.deepEqual(result, { content: [{ type: 'text', text: 'echo:hi' }] });
  t.deepEqual(calls, [['echo', 'hi']]);
});

test('tools/call outside the catalog is a name-scope rejection', async t => {
  const { server, calls } = makeFixture();
  for (const name of ['absent', 'foo__bar', '__proto__', 'toString', 42]) {
    // eslint-disable-next-line no-await-in-loop
    const { error } = await request(server, 'tools/call', { name });
    t.is(error.code, TOOL_NOT_PERMITTED);
    t.is(error.message, 'tool-not-permitted');
    t.is(error.data.reason, 'name-scope');
  }
  t.deepEqual(calls, []);
});

test('tools/call with out-of-shape arguments is an argument-scope rejection', async t => {
  const { server, calls } = makeFixture();
  const { error } = await request(server, 'tools/call', {
    name: 'echo',
    arguments: { text: 5 },
  });
  t.is(error.code, TOOL_NOT_PERMITTED);
  t.is(error.data.reason, 'argument-scope');
  const extra = await request(server, 'tools/call', {
    name: 'echo',
    arguments: { text: 'x', formulaId: 'a'.repeat(64) },
  });
  t.is(extra.error.data.reason, 'argument-scope');
  t.deepEqual(calls, []);
});

test('a facet-method throw is an isError result, not a protocol error', async t => {
  const { server, notifications } = makeFixture();
  const response = await request(server, 'tools/call', { name: 'fail' });
  t.is(response.error, undefined);
  t.true(response.result.isError);
  t.regex(response.result.content[0].text, /no such file/);
  t.is(notifications.length, 1);
});

test('a dropped connection is bridge-down, in flight and afterwards', async t => {
  const closed = makePromiseKit();
  const hang = makePromiseKit();
  const { server } = makeFixture({
    connectionClosed: closed.promise,
    methods: { hang: () => hang.promise },
  });
  const inFlight = request(server, 'tools/call', { name: 'hang' });
  closed.resolve(undefined);
  const { error } = await inFlight;
  t.is(error.code, BRIDGE_DOWN);
  t.is(error.message, 'bridge-down');
  t.is(typeof error.data.detail, 'string');
  const after = await request(server, 'tools/call', {
    name: 'echo',
    arguments: { text: 'x' },
  });
  t.is(after.error.code, BRIDGE_DOWN);
});

test('protocol errors: parse, invalid request, unknown method, notifications', async t => {
  const { server } = makeFixture();
  t.is(
    JSON.parse(/** @type {string} */ (await server.handleLine('{'))).error.code,
    PARSE_ERROR,
  );
  t.is(
    /** @type {any} */ (await server.handleMessage([])).error.code,
    INVALID_REQUEST,
  );
  t.is(
    /** @type {any} */ (await server.handleMessage({ id: 1, method: 'ping' }))
      .error.code,
    INVALID_REQUEST,
  );
  t.is((await request(server, 'resources/list')).error.code, METHOD_NOT_FOUND);
  t.is(
    await server.handleMessage({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
    undefined,
  );
  t.deepEqual((await request(server, 'ping')).result, {});
});

test('logging facet honors logging/setLevel', async t => {
  const { server, notifications } = makeFixture();
  server.log('debug', 'hidden');
  t.is(notifications.length, 0);
  await request(server, 'logging/setLevel', { level: 'debug' });
  server.log('debug', 'shown');
  t.deepEqual(notifications, [
    {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'debug', logger: 'endo', data: 'shown' },
    },
  ]);
});

test('initialize answers an unsupported protocol version with its own', async t => {
  const { server } = makeFixture();
  for (const protocolVersion of ['2024-11-05', '1999-01-01', 7, undefined]) {
    // eslint-disable-next-line no-await-in-loop
    const { result } = await request(server, 'initialize', { protocolVersion });
    t.is(result.protocolVersion, '2025-06-18', String(protocolVersion));
  }
});

test('a valid notification or a response is never answered', async t => {
  const { server } = makeFixture();
  for (const message of [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 3, result: {} },
    { jsonrpc: '2.0', id: 3, error: { code: 1, message: 'x' } },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const reply = await server.handleMessage(message);
    t.is(reply, undefined, JSON.stringify(message));
  }
});

test('an invalid request without an id is answered with id null', async t => {
  const { server } = makeFixture();
  for (const message of [
    // JSON-RPC 2.0 §7: `{"jsonrpc": "2.0", "method": 1, "params": "bar"}`.
    { jsonrpc: '2.0', method: 1, params: 'bar' },
    { jsonrpc: '1.0', method: 'foo' },
    { method: 123 },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const reply = /** @type {any} */ (await server.handleMessage(message));
    t.is(reply?.error.code, INVALID_REQUEST, JSON.stringify(message));
    t.is(reply?.id, null, JSON.stringify(message));
  }
});

test('an id that is null or not an integer is an invalid request', async t => {
  const { server } = makeFixture();
  for (const id of [null, 1.5, true, {}]) {
    const message = { jsonrpc: '2.0', id, method: 'ping' };
    // eslint-disable-next-line no-await-in-loop
    const reply = /** @type {any} */ (await server.handleMessage(message));
    t.is(reply?.error.code, INVALID_REQUEST, JSON.stringify(id));
    t.is(reply?.id, null, JSON.stringify(id));
  }
});

test('logging/setLevel with a non-string level is invalid params', async t => {
  const { server } = makeFixture();
  const { error } = await request(server, 'logging/setLevel', {
    level: { toString: 1 },
  });
  t.is(error.code, INVALID_PARAMS);
  const line = await server.handleLine(
    '{"jsonrpc":"2.0","id":7,"method":"logging/setLevel","params":{"level":{"toString":1}}}',
  );
  t.is(JSON.parse(line ?? '').id, 7);
});

test('a throw while answering is an internal-error reply, never silence', async t => {
  const target = makeExo('Guest', GuestFixtureInterface, {
    fail: () => {
      throw Error('no such file');
    },
  });
  const server = makeMcpToolServer({
    catalog: makeToolCatalog([tool('fail')]),
    target,
    serverInfo: { name: 'endo', version: '0.0.0' },
    notify: () => {
      throw Error('client gone');
    },
  });
  const line = await server.handleLine(
    '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"fail","arguments":{"text":"x"}}}',
  );
  const reply = JSON.parse(line ?? '');
  t.is(reply.id, 9);
  t.is(reply.error.code, INTERNAL_ERROR);
  t.regex(reply.error.data.detail, /client gone/);
});

test('catalog: a tool name is at most 64 characters', t => {
  const longest = `a${'b'.repeat(63)}`;
  t.deepEqual(makeToolCatalog([tool(longest)]).names, [longest]);
  const error = t.throws(() => makeToolCatalog([tool(`${longest}c`)]));
  t.is(reasonOf(error), 'malformed-name');
});
