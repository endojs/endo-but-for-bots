// @ts-check
// spell-out-exempt: `temp` is the @endo/where platform-info field name.

import test from '@endo/ses-ava/prepare-endo.js';
import { PassThrough } from 'node:stream';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';

import { main } from '../src/main.js';
import { renderGuestAllowedTools } from '../src/config.js';
import { makeAgentTools } from '../src/agent-interface.js';

/** @import { ExecutionContext } from 'ava' */

const FORMULA_ID = 'ab'.repeat(32);
const OTHER_ID = 'cd'.repeat(32);
const NODE = '12'.repeat(32);

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
 * @param {Record<string, string | undefined>} [options.env]
 * @param {() => Promise<any>} [options.connect]
 */
const startServer = ({
  env = { ENDO_GUEST_FORMULA_ID: FORMULA_ID },
  connect,
} = {}) => {
  /** @type {unknown[][]} */
  const calls = [];
  const closed = makePromiseKit();
  let closedCount = 0;
  const guests = {
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
      if (!Object.hasOwn(guests, id)) throw Error('Unknown formula');
      return guests[id];
    },
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let stderrText = '';
  const stderr = {
    write: (chunk, callback) => {
      stderrText += chunk;
      callback?.();
    },
  };
  /** @type {any[]} */
  const frames = [];
  let stdoutBuffer = '';
  stdout.on('data', chunk => {
    stdoutBuffer += chunk;
    let i = stdoutBuffer.indexOf('\n');
    while (i >= 0) {
      frames.push(JSON.parse(stdoutBuffer.slice(0, i)));
      stdoutBuffer = stdoutBuffer.slice(i + 1);
      i = stdoutBuffer.indexOf('\n');
    }
  });
  const exit = main({
    env,
    platform: 'linux',
    info: { user: 'u', home: '/nonexistent', temp: '/tmp' },
    stdin,
    stdout,
    stderr,
    version: '0.0.0',
    connect:
      connect ??
      (async () => ({
        host,
        closed: closed.promise,
        close: () => {
          closedCount += 1;
          closed.resolve(undefined);
        },
      })),
  });
  let nextId = 1;
  /**
   * @param {string} method
   * @param {unknown} [params]
   */
  const rpc = async (method, params) => {
    const id = nextId;
    nextId += 1;
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (;;) {
      const frame = frames.find(f => f.id === id);
      if (frame) return frame;
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 5));
    }
  };
  return {
    rpc,
    stdin,
    exit,
    calls,
    frames,
    dropConnection: () => closed.resolve(undefined),
    stderr: () => stderrText,
    closedCount: () => closedCount,
  };
};

test('a full session serves the static catalog against the one configured guest', async t => {
  const { rpc, stdin, exit, calls, frames, closedCount } = startServer();
  const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
  t.is(init.result.serverInfo.name, 'endo');
  t.deepEqual(init.result.capabilities.tools, { listChanged: false });

  const list = await rpc('tools/list');
  const names = list.result.tools.map(({ name }) => name);
  t.deepEqual(
    names,
    makeAgentTools().map(({ name }) => name),
  );
  // Catalog parity with the harness allow-list.
  t.deepEqual(
    renderGuestAllowedTools(),
    names.map(name => `mcp__endo__${name}`),
  );

  const has = await rpc('tools/call', {
    name: 'has',
    arguments: { petNamePath: ['present'] },
  });
  t.deepEqual(has.result, { content: [{ type: 'text', text: 'true' }] });

  // A client attempt to name a different guest is refused, not honored.
  const forged = await rpc('tools/call', {
    name: 'has',
    arguments: { petNamePath: ['present'], formulaId: OTHER_ID },
  });
  t.is(forged.error.code, -32_001);
  t.is(forged.error.data.reason, 'argument-scope');
  const initForged = await rpc('initialize', { formulaId: OTHER_ID });
  t.is(initForged.result.serverInfo.name, 'endo');

  // Facet-method throw: a successful result with isError.
  const missing = await rpc('tools/call', {
    name: 'readText',
    arguments: { petNamePath: ['missing'] },
  });
  t.true(missing.result.isError);
  t.regex(missing.result.content[0].text, /Unknown pet name: missing/);

  // Name scope: host-only names never reach the guest.
  for (const name of ['provideGuest', 'provideHost', 'lookupById']) {
    // eslint-disable-next-line no-await-in-loop
    const refused = await rpc('tools/call', { name, arguments: {} });
    t.is(refused.error.data.reason, 'name-scope');
  }

  // Message numbers arrive as JSON and reach the guest as bigints.
  await rpc('tools/call', { name: 'dismiss', arguments: { messageNumber: 7 } });
  const badNumber = await rpc('tools/call', {
    name: 'dismiss',
    arguments: { messageNumber: 'seven' },
  });
  t.is(badNumber.error.data.reason, 'argument-scope');

  stdin.end();
  t.is(await exit, 0);
  t.is(closedCount(), 1);

  // Every call reached only the configured guest, resolved exactly once.
  t.deepEqual(
    calls.filter(([who]) => who === 'host'),
    [['host', 'lookupById', FORMULA_ID]],
  );
  t.false(calls.some(([who]) => who === 'other'));
  t.deepEqual(
    calls.find(([, method]) => method === 'dismiss'),
    ['mine', 'dismiss', 7n],
  );

  // The formula id never appears on the MCP wire (the client's own forged
  // requests aside, no reply frame carries either id).
  const wire = JSON.stringify(frames);
  t.false(wire.includes(FORMULA_ID));
  t.false(wire.includes(OTHER_ID));
});

test('readFollower bounds are enforced end to end through tools/call', async t => {
  const { rpc, stdin, exit } = startServer();
  await rpc('initialize', { protocolVersion: '2025-06-18' });
  /** @param {Record<string, unknown>} bounds */
  const read = async bounds => {
    const opened = await rpc('tools/call', {
      name: 'followNameChanges',
      arguments: {},
    });
    const { follower } = JSON.parse(opened.result.content[0].text);
    return rpc('tools/call', {
      name: 'readFollower',
      arguments: { follower, ...bounds },
    });
  };
  for (const bounds of [
    { maxItems: 1 },
    { maxItems: 256 },
    { waitMilliseconds: 0 },
    { waitMilliseconds: 30_000 },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const accepted = await read(bounds);
    t.is(accepted.error, undefined, JSON.stringify(bounds));
    t.deepEqual(
      JSON.parse(accepted.result.content[0].text),
      { items: [], done: true },
      JSON.stringify(bounds),
    );
  }
  for (const bounds of [
    { maxItems: 0 },
    { maxItems: 257 },
    { maxItems: 1.5 },
    { waitMilliseconds: -1 },
    { waitMilliseconds: 30_001 },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const refused = await read(bounds);
    t.is(refused.error?.code, -32_001, JSON.stringify(bounds));
    t.is(refused.error?.data.reason, 'argument-scope', JSON.stringify(bounds));
  }
  stdin.end();
  t.is(await exit, 0);
});

test('define refuses a slot key its schema does not declare', async t => {
  const { rpc, stdin, exit, calls } = startServer();
  await rpc('initialize', { protocolVersion: '2025-06-18' });
  const smuggled = await rpc('tools/call', {
    name: 'define',
    arguments: {
      source: 'x',
      slots: { a: { label: 'l', smuggled: { deep: 1 } } },
    },
  });
  t.is(smuggled.error?.code, -32_001);
  t.is(smuggled.error?.data.reason, 'argument-scope');
  const plain = await rpc('tools/call', {
    name: 'define',
    arguments: { source: 'x', slots: { a: { label: 'l' } } },
  });
  t.is(plain.error, undefined);
  t.deepEqual(
    calls.filter(([, method]) => method === 'define'),
    [['mine', 'define', ['x', { a: { label: 'l' } }]]],
  );
  stdin.end();
  t.is(await exit, 0);
});

test('a dropped daemon connection is bridge-down, never a success', async t => {
  const { rpc, stdin, exit, dropConnection } = startServer();
  await rpc('initialize', {});
  dropConnection();
  await new Promise(r => setTimeout(r, 10));
  const response = await rpc('tools/call', { name: 'list', arguments: {} });
  t.is(response.error.code, -32_010);
  t.is(response.error.message, 'bridge-down');
  stdin.end();
  t.is(await exit, 0);
});

test('malformed frames and unknown methods are protocol errors', async t => {
  const { rpc, stdin, exit, frames } = startServer();
  stdin.write('{not json\n');
  const unknown = await rpc('resources/list');
  t.is(unknown.error.code, -32_601);
  t.true(frames.some(f => f.id === null && f.error.code === -32_700));
  // U+2028 inside a string does not split a frame.
  const sep = await rpc('tools/call', {
    name: 'has',
    arguments: { petNamePath: ['a\u2028b'] },
  });
  t.deepEqual(sep.result, { content: [{ type: 'text', text: 'false' }] });
  stdin.end();
  await exit;
});

test('stdin EOF closes the daemon session while a call is pending', async t => {
  const { rpc, stdin, exit, frames, closedCount } = startServer();
  await rpc('initialize', {});
  stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: {
        name: 'request',
        arguments: { recipient: ['someone'], description: 'never answered' },
      },
    })}\n`,
  );
  await new Promise(r => setTimeout(r, 10));
  stdin.end();
  t.is(await exit, 0);
  t.is(closedCount(), 1);
  t.is(frames.find(f => f.id === 99)?.error.code, -32_010);
});

/**
 * @param {ExecutionContext} t
 * @param {ReturnType<typeof startServer>} server
 * @param {string} reason
 */
const assertConstructionFailure = async (t, server, reason) => {
  t.is(await server.exit, 1);
  t.is(server.frames.length, 0, 'never answers initialize');
  const record = JSON.parse(server.stderr().trim().split('\n').at(-1) ?? '');
  t.is(record.reason, reason);
  t.is(record.level, 'error');
};

test('construction fails closed: missing formula id', async t => {
  await assertConstructionFailure(
    t,
    startServer({ env: {} }),
    'invalid-formula-id',
  );
});

test('construction fails closed: non-64-hex formula id', async t => {
  await assertConstructionFailure(
    t,
    startServer({ env: { ENDO_GUEST_FORMULA_ID: 'AB'.repeat(32) } }),
    'invalid-formula-id',
  );
});

test('construction fails closed: unresolvable formula id', async t => {
  await assertConstructionFailure(
    t,
    startServer({ env: { ENDO_GUEST_FORMULA_ID: 'ef'.repeat(32) } }),
    'invalid-formula-id',
  );
});

test('construction fails closed: formula id resolving to a host', async t => {
  const host = makeFake('EndoHost', {
    lookupById: () => host,
    provideGuest: () => {},
  });
  await assertConstructionFailure(
    t,
    startServer({
      connect: async () => ({
        host,
        closed: new Promise(() => {}),
        close: () => {},
      }),
    }),
    'invalid-formula-id',
  );
});

/**
 * @param {ExecutionContext} t
 * @param {any} impostor - what the formula id resolves to.
 */
const assertRefusedAsGuest = async (t, impostor) => {
  const host = makeFake('EndoHost', { lookupById: () => impostor });
  await assertConstructionFailure(
    t,
    startServer({
      connect: async () => ({
        host,
        closed: new Promise(() => {}),
        close: () => {},
      }),
    }),
    'invalid-formula-id',
  );
};

test('construction fails closed: a full guest method set plus a host-only method', async t => {
  const calls = [];
  const guest = makeFakeGuest('impostor', calls);
  const guestMethods = Object.fromEntries(
    // eslint-disable-next-line no-underscore-dangle
    (await guest.__getMethodNames__())
      .filter(name => typeof name === 'string' && !name.startsWith('__'))
      .map(name => [name, () => {}]),
  );
  await assertRefusedAsGuest(
    t,
    makeFake('EndoGuest', { ...guestMethods, provideShell: () => {} }),
  );
});

test('construction fails closed: a full guest method set under a host interface name', async t => {
  const calls = [];
  const guest = makeFakeGuest('impostor', calls);
  const guestMethods = Object.fromEntries(
    // eslint-disable-next-line no-underscore-dangle
    (await guest.__getMethodNames__())
      .filter(name => typeof name === 'string' && !name.startsWith('__'))
      .map(name => [name, () => {}]),
  );
  await assertRefusedAsGuest(t, makeFake('EndoHost', guestMethods));
});

test('construction fails closed: unreachable daemon', async t => {
  await assertConstructionFailure(
    t,
    startServer({
      connect: async () => {
        throw Error('Cannot connect to Endo. Is Endo running?');
      },
    }),
    'daemon-unreachable',
  );
});

test('a fully qualified number:node formula id is accepted', async t => {
  const { rpc, stdin, exit, calls } = startServer({
    env: { ENDO_GUEST_FORMULA_ID: `${FORMULA_ID}:${NODE}` },
  });
  const init = await rpc('initialize', {});
  t.is(init.result.serverInfo.name, 'endo');
  stdin.end();
  t.is(await exit, 0);
  t.deepEqual(calls, [['host', 'lookupById', FORMULA_ID]]);
});
