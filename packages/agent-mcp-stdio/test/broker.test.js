// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

import {
  RELAY_PATH,
  makeRelayTransport,
  startGuestBroker,
} from '../src/broker.js';
import { confinedToolNames } from '../src/confined.js';

const FORMULA_ID = 'ab'.repeat(32);
const OTHER_ID = 'cd'.repeat(32);
const NODE = '12'.repeat(32);
const CREDENTIAL = 'sk-ant-oat01-must-not-reach-the-mcp-child';
const DAEMON_SOCK = '/run/user/1000/endo/captp0.sock';

/**
 * @param {string} name
 * @param {Record<string, (...methodArguments: any[]) => any>} methods
 */
const makeFake = (name, methods) =>
  makeExo(
    name,
    M.interface(name, {}, { defaultGuards: 'passable' }),
    /** @type {any} */ (methods),
  );

/**
 * @param {string} label
 * @param {unknown[][]} calls
 */
const makeFakeGuest = (label, calls) =>
  makeFake('EndoGuest', {
    help: () => `help for ${label}`,
    has: () => false,
    list: () => {
      calls.push([label, 'list']);
      return [`${label}-name`];
    },
    remove: () => {},
    move: () => {},
    copy: () => {},
    makeDirectory: () => {},
    readText: () => '',
    writeText: () => {},
    listMessages: () => [],
    send: () => {},
    reply: () => {},
    adopt: () => {},
    dismiss: () => {},
    request: () => new Promise(() => {}),
    define: () => {
      calls.push([label, 'define']);
    },
    evaluate: () => {
      calls.push([label, 'evaluate']);
    },
    storeIdentifier: () => {
      calls.push([label, 'storeIdentifier']);
    },
  });

const makeFakeConnection = () => {
  /** @type {unknown[][]} */
  const calls = [];
  const closed = makePromiseKit();
  const guests = {
    [FORMULA_ID]: makeFakeGuest('mine', calls),
    [OTHER_ID]: makeFakeGuest('other', calls),
  };
  const host = makeFake('EndoHost', {
    identify: name =>
      name === '@agent' ? `${'00'.repeat(32)}:${NODE}` : undefined,
    lookupById: qualified => {
      const [id] = qualified.split(':');
      calls.push(['host', 'lookupById', id]);
      if (!Object.hasOwn(guests, id)) throw Error('Unknown formula');
      return guests[id];
    },
  });
  return {
    calls,
    connection: harden({ host, closed: closed.promise, close: () => {} }),
  };
};

/**
 * Spawn a transport as Claude Code does: its own environment merged with the
 * server entry's. Here `claude`'s environment holds a credential and the
 * daemon socket, the worst case endo-but-for-bots#1369 gap 2 observed.
 *
 * @param {{ command: string, args: string[] }} transport
 */
const spawnAsClaudeWould = transport =>
  spawn(transport.command, transport.args, {
    env: {
      PATH: process.env.PATH,
      HOME: '/home/someone',
      ANTHROPIC_AUTH_TOKEN: CREDENTIAL,
      ANTHROPIC_API_KEY: CREDENTIAL,
      CLAUDE_CODE_OAUTH_TOKEN: CREDENTIAL,
      ENDO_SOCK: DAEMON_SOCK,
      XDG_RUNTIME_DIR: '/run/user/1000',
      CLAUDECODE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

/**
 * Drive an MCP session over a child's stdio.
 *
 * @param {import('node:child_process').ChildProcessWithoutNullStreams} child
 */
const makeClient = child => {
  let buffer = '';
  /** @type {Map<number, (frame: any) => void>} */
  const waiting = new Map();
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let i = buffer.indexOf('\n');
    while (i >= 0) {
      const frame = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(frame.id)?.(frame);
      i = buffer.indexOf('\n');
    }
  });
  let nextId = 0;
  /**
   * @param {string} method
   * @param {object} [params]
   */
  const request = (method, params = {}) => {
    nextId += 1;
    const id = nextId;
    return new Promise(resolve => {
      waiting.set(id, resolve);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });
  };
  return { request };
};

test('makeRelayTransport empties the relay environment with env -i', t => {
  const transport = makeRelayTransport({
    socketPath: '/tmp/x/mcp.sock',
    nodePath: '/usr/bin/node',
  });
  t.deepEqual(transport, {
    kind: 'stdio',
    command: '/usr/bin/env',
    args: ['-i', '/usr/bin/node', RELAY_PATH, '/tmp/x/mcp.sock'],
  });
  // No NAME=VALUE operand follows `-i`: nothing is re-admitted.
  t.false(transport.args.some(arg => arg.includes('=')));
  t.throws(() => makeRelayTransport({ socketPath: 'relative.sock' }));
});

test('the relay reaches exactly one guest, with no credential, daemon socket, or HOME in its environment', async t => {
  const { calls, connection } = makeFakeConnection();
  const broker = await startGuestBroker({
    connection,
    formulaId: FORMULA_ID,
    version: '0.0.0-test',
  });
  t.teardown(() => broker.close());

  // The broker directory is private to the harness user.
  const dirMode = fs.statSync(broker.socketPath.replace(/\/[^/]+$/, '')).mode;
  t.is(dirMode.toString(8).slice(-3), '700');

  const transport = await broker.transport();
  const rendered = JSON.stringify(transport);
  t.false(rendered.includes(DAEMON_SOCK));
  t.false(rendered.includes(FORMULA_ID), 'the relay is not told the guest');

  const child = spawnAsClaudeWould(transport);
  const exited = new Promise(resolve => child.on('exit', resolve));
  const client = makeClient(child);

  const init = await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'scripted-client', version: '0' },
  });
  t.is(init.result.serverInfo.name, 'endo');

  // The relay is running now: read its environment from the kernel, not from
  // anything it reports about itself.
  if (process.platform === 'linux') {
    const environ = fs.readFileSync(`/proc/${child.pid}/environ`, 'utf-8');
    const names = environ
      .split('\0')
      .filter(Boolean)
      .map(entry => entry.split('=')[0]);
    t.deepEqual(names, [], 'the relay environment is empty');
    t.false(environ.includes(CREDENTIAL));
    t.false(environ.includes(DAEMON_SOCK));
  } else {
    t.log('not Linux: environ check skipped');
  }

  const list = await client.request('tools/list');
  t.true(list.result.tools.some(tool => tool.name === 'list'));
  t.deepEqual(
    list.result.tools.map(tool => tool.name),
    (await broker.toolsList()).map(tool => tool.name),
  );

  const called = await client.request('tools/call', {
    name: 'list',
    arguments: {},
  });
  t.falsy(called.result.isError);
  t.true(JSON.stringify(called.result).includes('mine-name'));

  // A smuggled formula id is refused at the argument scope.
  const smuggled = await client.request('tools/call', {
    name: 'list',
    arguments: { formulaId: OTHER_ID },
  });
  t.is(smuggled.error.data.reason, 'argument-scope');

  child.stdin.end();
  t.is(await exited, 0);

  t.deepEqual(
    calls.filter(([who]) => who !== 'host'),
    [['mine', 'list']],
    'only the one guest was reached',
  );
  t.deepEqual(calls.filter(([who]) => who === 'host').length, 1);
});

test('startGuestBroker fails closed on a non-guest formula', async t => {
  const { connection } = makeFakeConnection();
  await t.throwsAsync(
    startGuestBroker({
      connection,
      formulaId: 'ef'.repeat(32),
      version: '0',
    }),
    { message: /does not resolve to a guest/ },
  );
  await t.throwsAsync(
    startGuestBroker({ connection, formulaId: 'not-hex', version: '0' }),
    { message: /ENDO_GUEST_FORMULA_ID/ },
  );
});

test('close removes the broker socket and directory', async t => {
  const { connection } = makeFakeConnection();
  const broker = await startGuestBroker({
    connection,
    formulaId: FORMULA_ID,
    version: '0',
  });
  t.true(fs.existsSync(broker.socketPath));
  await broker.close();
  t.false(fs.existsSync(broker.socketPath.replace(/\/[^/]+$/, '')));
});

test('the broker serves only the confined allow-list and refuses withheld names', async t => {
  const { calls, connection } = makeFakeConnection();
  const broker = await startGuestBroker({
    connection,
    formulaId: FORMULA_ID,
    version: '0.0.0-test',
  });
  t.teardown(() => broker.close());

  const withheld = [
    'evaluate',
    'define',
    'identify',
    'storeIdentifier',
    'locate',
    'storeLocator',
    'invite',
    'accept',
  ];
  const listed = (await broker.toolsList()).map(tool => tool.name);
  t.true(listed.length > 0);
  for (const name of listed) {
    t.true(confinedToolNames.includes(name), `${name} is allowed`);
  }
  for (const name of withheld) {
    t.false(listed.includes(name), `${name} is not listed`);
  }

  const child = spawnAsClaudeWould(await broker.transport());
  const exited = new Promise(resolve => child.on('exit', resolve));
  const client = makeClient(child);
  await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'scripted-client', version: '0' },
  });

  // What the confined side sees is the pruned catalog, not the full one.
  const list = await client.request('tools/list');
  t.deepEqual(
    list.result.tools.map(tool => tool.name),
    listed,
  );

  // A withheld name is refused at call time even when the guest has the
  // method: the bridge dispatches only from the served catalog.
  /** @type {Array<[string, object]>} */
  const attempts = [
    ['define', { source: '1', slots: {} }],
    ['evaluate', { source: '1' }],
    ['storeIdentifier', { petNamePath: ['x'], identifier: OTHER_ID }],
  ];
  const refusals = await Promise.all(
    attempts.map(([name, toolArguments]) =>
      client.request('tools/call', { name, arguments: toolArguments }),
    ),
  );
  for (const [index, [name]] of attempts.entries()) {
    const { error } = /** @type {any} */ (refusals[index]);
    t.is(error.message, 'tool-not-permitted', name);
    t.is(error.data.reason, 'name-scope', name);
  }

  child.stdin.end();
  t.is(await exited, 0);
  t.deepEqual(
    calls.filter(([who]) => who !== 'host'),
    [],
    'no withheld method reached the guest',
  );
});

test('an explicit allow-list narrows the served catalog further', async t => {
  const { connection } = makeFakeConnection();
  const broker = await startGuestBroker({
    connection,
    formulaId: FORMULA_ID,
    version: '0',
    allowedToolNames: ['list', 'help'],
  });
  t.teardown(() => broker.close());
  t.deepEqual(
    (await broker.toolsList()).map(tool => tool.name),
    ['help', 'list'],
  );
});

test('an allow-list that admits no declared tool fails closed', async t => {
  const { connection } = makeFakeConnection();
  await t.throwsAsync(
    startGuestBroker({
      connection,
      formulaId: FORMULA_ID,
      version: '0',
      allowedToolNames: ['noSuchTool'],
    }),
    { message: /no tools/ },
  );
});
