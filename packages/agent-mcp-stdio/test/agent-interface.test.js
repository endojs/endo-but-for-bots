// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { fc } from '@fast-check/ava';
import { makeToolCatalog } from '@endo/agent-tools/adapters/mcp.js';
import { makeExo } from '@endo/exo';
import { readerFromIterator } from '@endo/exo-stream/reader-from-iterator.js';
import { M, matches } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

import { makeAgentTools, toMessageNumber } from '../src/agent-interface.js';

/** @import { ToolDeclaration } from '@endo/agent-tools/adapters/mcp.js' */
import { makeMcpConfig } from '../src/config.js';

/**
 * @param {Record<string, (...methodArguments: any[]) => any>} methods
 */
const makeFakeGuest = methods =>
  makeExo(
    'EndoGuest',
    M.interface('EndoGuest', {}, { defaultGuards: 'passable' }),
    /** @type {any} */ (methods),
  );

/**
 * @param {ReadonlyArray<ToolDeclaration<any>>} tools
 * @param {string} name
 */
const toolNamed = (tools, name) => {
  const found = tools.find(tool => tool.name === name);
  if (found === undefined) {
    throw Error(`No tool ${name}`);
  }
  return found;
};

test('the static agent interface is a valid catalog with no warnings', t => {
  const catalog = makeToolCatalog(makeAgentTools());
  t.deepEqual(catalog.warnings, []);
  for (const name of [
    'evaluate',
    'define',
    'makePath',
    'glob',
    'grep',
    'glorp',
    'storeLocator',
    'followMessages',
    'followStream',
    'readFollower',
  ]) {
    t.true(catalog.names.includes(name), name);
  }
});

test('evaluate forwards to the guest evaluator', async t => {
  /** @type {unknown[][]} */
  const calls = [];
  const guest = makeFakeGuest({
    evaluate: (...evaluateArguments) => {
      calls.push(evaluateArguments);
      return 42;
    },
  });
  const evaluate = toolNamed(makeAgentTools(), 'evaluate');
  t.is(
    await evaluate.invoke(guest, {
      source: 'x + 1',
      codeNames: ['x'],
      petNamePaths: [['x']],
    }),
    42,
  );
  t.deepEqual(calls, [[undefined, 'x + 1', ['x'], [['x']]]]);
});

test('makePath creates only the missing directories', async t => {
  const existing = new Set(['a']);
  /** @type {string[]} */
  const made = [];
  const guest = makeFakeGuest({
    has: (...path) => existing.has(path.join('/')),
    makeDirectory: path => {
      made.push(path.join('/'));
      existing.add(path.join('/'));
    },
  });
  const makePath = toolNamed(makeAgentTools(), 'makePath');
  await makePath.invoke(guest, { petNamePath: ['a', 'b', 'c'] });
  t.deepEqual(made, ['a/b', 'a/b/c']);
  t.regex(
    String(await makePath.invoke(guest, { petNamePath: ['a', 'b'] })),
    /already exists/,
  );
  t.deepEqual(made, ['a/b', 'a/b/c']);
});

test('concurrent makePath calls sharing a prefix create it once', async t => {
  const existing = new Set();
  /** @type {string[]} */
  const made = [];
  const tick = () => new Promise(resolve => setTimeout(resolve, 1));
  const guest = makeFakeGuest({
    has: async (...path) => {
      await tick();
      return existing.has(path.join('/'));
    },
    makeDirectory: async path => {
      await tick();
      const name = path.join('/');
      made.push(name);
      // Like the daemon, a new directory replaces whatever held the name.
      for (const child of [...existing]) {
        if (child.startsWith(`${name}/`)) {
          existing.delete(child);
        }
      }
      existing.add(name);
    },
  });
  const makePath = toolNamed(makeAgentTools(), 'makePath');
  await Promise.all([
    makePath.invoke(guest, { petNamePath: ['a', 'b'] }),
    makePath.invoke(guest, { petNamePath: ['a', 'c'] }),
  ]);
  t.deepEqual(made, ['a', 'a/b', 'a/c']);
  t.deepEqual([...existing].sort(), ['a', 'a/b', 'a/c']);
});

test('a closed follower holds its cap slot until its release settles', async t => {
  const LIMIT_FOLLOWERS = 64;
  const gate = makePromiseKit();
  const guest = makeFakeGuest({
    followNameChanges: async () =>
      readerFromIterator(
        /** @type {any} */ ({
          next: () =>
            gate.promise.then(() => ({ done: true, value: undefined })),
          return: async () => ({ done: true, value: undefined }),
          [Symbol.asyncIterator]() {
            return this;
          },
        }),
      ),
  });
  const tools = makeAgentTools({ delay: async () => {} });
  const open = toolNamed(tools, 'followNameChanges');
  /** @type {string[]} */
  const opened = [];
  for (let i = 0; i < LIMIT_FOLLOWERS; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { follower } = /** @type {any} */ (await open.invoke(guest, {}));
    opened.push(follower);
  }
  t.is(opened.length, LIMIT_FOLLOWERS);
  await t.throwsAsync(async () => open.invoke(guest, {}), {
    message: /Too many open followers \(64, counting 0 /,
  });

  // A timed-out read leaves a pull pending on the quiet stream, so closing
  // the follower cannot release its subscription yet.
  const [first] = opened;
  t.deepEqual(
    await toolNamed(tools, 'readFollower').invoke(guest, { follower: first }),
    { items: [], done: false },
  );
  await toolNamed(tools, 'closeFollower').invoke(guest, { follower: first });
  await t.throwsAsync(async () => open.invoke(guest, {}), {
    message: /counting 1 closed but not yet released/,
  });

  // Once the pending pull and the return settle, the slot is free again.
  gate.resolve(undefined);
  /** @type {any} */
  let admitted;
  for (let attempt = 0; attempt < 100 && admitted === undefined; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 5));
    try {
      // eslint-disable-next-line no-await-in-loop
      admitted = await open.invoke(guest, {});
    } catch {
      // Still releasing.
    }
  }
  t.truthy(admitted?.follower);
  await t.throwsAsync(async () => open.invoke(guest, {}), {
    message: /Too many open followers/,
  });
});

test('a follower drains a stream in bounded pulls', async t => {
  async function* messages() {
    yield 'one';
    yield 'two';
    yield 'three';
  }
  const guest = makeFakeGuest({
    followMessages: async () => readerFromIterator(messages()),
  });
  const tools = makeAgentTools({ delay: () => new Promise(() => {}) });
  const { follower } = /** @type {any} */ (
    await toolNamed(tools, 'followMessages').invoke(guest, {})
  );
  const readFollower = toolNamed(tools, 'readFollower');
  t.deepEqual(await readFollower.invoke(guest, { follower, maxItems: 2 }), {
    items: ['one', 'two'],
    done: false,
  });
  t.deepEqual(await readFollower.invoke(guest, { follower }), {
    items: ['three'],
    done: true,
  });
  await t.throwsAsync(async () => readFollower.invoke(guest, { follower }), {
    message: /No open follower/,
  });
});

test('a quiet follower returns what it has when the wait elapses', async t => {
  const guest = makeFakeGuest({
    followNameChanges: async () =>
      readerFromIterator(
        /** @type {any} */ ({
          next: () => new Promise(() => {}),
          return: async () => ({ done: true, value: undefined }),
          [Symbol.asyncIterator]() {
            return this;
          },
        }),
      ),
  });
  const tools = makeAgentTools({ delay: async () => {} });
  const { follower } = /** @type {any} */ (
    await toolNamed(tools, 'followNameChanges').invoke(guest, {})
  );
  t.deepEqual(
    await toolNamed(tools, 'readFollower').invoke(guest, { follower }),
    { items: [], done: false },
  );
  t.is(
    await toolNamed(tools, 'closeFollower').invoke(guest, { follower }),
    `Closed ${follower}`,
  );
});

test('concurrent reads of one follower take each item exactly once', async t => {
  async function* messages() {
    yield 'one';
    yield 'two';
    yield 'three';
  }
  const guest = makeFakeGuest({
    followMessages: async () => readerFromIterator(messages()),
  });
  const tools = makeAgentTools({ delay: () => new Promise(() => {}) });
  const { follower } = /** @type {any} */ (
    await toolNamed(tools, 'followMessages').invoke(guest, {})
  );
  const readFollower = toolNamed(tools, 'readFollower');
  const reads = await Promise.all([
    readFollower.invoke(guest, { follower, maxItems: 1 }),
    readFollower.invoke(guest, { follower, maxItems: 1 }),
    readFollower.invoke(guest, { follower, maxItems: 1 }),
  ]);
  t.deepEqual(
    reads.map(read => /** @type {any} */ (read).items),
    [['one'], ['two'], ['three']],
  );
});

test('a queued read returns within its own wait, not behind earlier reads', async t => {
  /** @type {Array<() => void>} */
  const timers = [];
  const delay = () =>
    /** @type {Promise<void>} */ (
      new Promise(resolve => {
        timers.push(resolve);
      })
    );
  const guest = makeFakeGuest({
    followNameChanges: async () =>
      readerFromIterator(
        /** @type {any} */ ({
          next: () => new Promise(() => {}),
          return: async () => ({ done: true, value: undefined }),
          [Symbol.asyncIterator]() {
            return this;
          },
        }),
      ),
  });
  const tools = makeAgentTools({ delay });
  const { follower } = /** @type {any} */ (
    await toolNamed(tools, 'followNameChanges').invoke(guest, {})
  );
  const readFollower = toolNamed(tools, 'readFollower');
  let firstSettled = false;
  const first = Promise.resolve(
    readFollower.invoke(guest, { follower, waitMilliseconds: 30_000 }),
  ).then(read => {
    firstSettled = true;
    return read;
  });
  const second = readFollower.invoke(guest, {
    follower,
    waitMilliseconds: 10,
  });
  t.is(timers.length, 2, 'both waits start at the call');
  // Only the second, queued read's wait elapses.
  timers[1]();
  t.deepEqual(await second, { items: [], done: false });
  t.false(firstSettled, 'the first read still holds the follower');
  timers[0]();
  t.deepEqual(await first, { items: [], done: false });
});

test('a read whose wait elapsed in the queue takes no item', async t => {
  /** @type {Array<() => void>} */
  const timers = [];
  const delay = () =>
    /** @type {Promise<void>} */ (
      new Promise(resolve => {
        timers.push(resolve);
      })
    );
  /** @type {(value: IteratorResult<string>) => void} */
  let yieldNext = () => {};
  let nextCount = 0;
  const guest = makeFakeGuest({
    followMessages: async () =>
      readerFromIterator(
        /** @type {any} */ ({
          next: () => {
            nextCount += 1;
            return nextCount === 1
              ? new Promise(resolve => {
                  yieldNext = resolve;
                })
              : Promise.resolve({ done: false, value: `item${nextCount}` });
          },
          return: async () => ({ done: true, value: undefined }),
          [Symbol.asyncIterator]() {
            return this;
          },
        }),
      ),
  });
  const tools = makeAgentTools({ delay });
  const { follower } = /** @type {any} */ (
    await toolNamed(tools, 'followMessages').invoke(guest, {})
  );
  const readFollower = toolNamed(tools, 'readFollower');
  const first = readFollower.invoke(guest, { follower, maxItems: 1 });
  const second = readFollower.invoke(guest, { follower, maxItems: 1 });
  timers[1]();
  t.deepEqual(await second, { items: [], done: false });
  yieldNext({ done: false, value: 'item1' });
  t.deepEqual(await first, { items: ['item1'], done: false });
  const third = readFollower.invoke(guest, { follower, maxItems: 1 });
  t.deepEqual(await third, { items: ['item2'], done: false });
});

test('readFollower refuses a fractional maxItems', async t => {
  async function* changes() {
    yield 'one';
  }
  const guest = makeFakeGuest({
    followNameChanges: async () => readerFromIterator(changes()),
  });
  const tools = makeAgentTools({ delay: () => new Promise(() => {}) });
  const { follower } = /** @type {any} */ (
    await toolNamed(tools, 'followNameChanges').invoke(guest, {})
  );
  await t.throwsAsync(
    async () =>
      toolNamed(tools, 'readFollower').invoke(guest, {
        follower,
        maxItems: 1.5,
      }),
    { message: /maxItems must be an integer/ },
  );
});

test('toMessageNumber maps every non-negative safe integer and its decimal string to the same bigint', t => {
  fc.assert(
    fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), n => {
      t.is(toMessageNumber(n), BigInt(n));
      t.is(toMessageNumber(String(n)), BigInt(n));
      t.is(toMessageNumber(`+${n}`), BigInt(n));
    }),
  );
});

test('toMessageNumber accepts every natural-number digit string, beyond the safe-integer range', t => {
  fc.assert(
    fc.property(fc.bigInt({ min: 0n }), n => {
      t.is(toMessageNumber(String(n)), n);
    }),
  );
});

test('toMessageNumber rejects every number that is not a non-negative safe integer', t => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.double({ noInteger: true }),
        fc.integer({ max: -1 }),
        fc.double({ min: Number.MAX_SAFE_INTEGER + 1, noNaN: true }),
        fc.constant(Number.NaN),
        fc.constant(Infinity),
        fc.constant(-Infinity),
      ),
      n => {
        t.throws(() => toMessageNumber(n), { instanceOf: TypeError });
      },
    ),
  );
});

test('toMessageNumber rejects every negative integer string', t => {
  fc.assert(
    fc.property(fc.bigInt({ max: -1n }), n => {
      t.throws(() => toMessageNumber(String(n)), { instanceOf: TypeError });
    }),
  );
});

test('toMessageNumber edge cases', t => {
  // Negative zero is a safe integer at least 0, and names message 0.
  t.is(toMessageNumber(-0), 0n);
  t.is(toMessageNumber('007'), 7n);
  const rejected = [
    '',
    '1.5',
    '1e3',
    ' 7',
    '7 ',
    '0x10',
    '++7',
    /** @type {any} */ (7n),
    /** @type {any} */ (null),
    /** @type {any} */ (undefined),
    /** @type {any} */ ({}),
  ];
  for (const value of rejected) {
    t.throws(() => toMessageNumber(value), { instanceOf: TypeError });
  }
});

test('a failing stream keeps the items already read and releases the follower', async t => {
  async function* messages() {
    yield 'one';
    throw Error('stream broke');
  }
  const guest = makeFakeGuest({
    followMessages: async () => readerFromIterator(messages()),
  });
  const tools = makeAgentTools({ delay: () => new Promise(() => {}) });
  const { follower } = /** @type {any} */ (
    await toolNamed(tools, 'followMessages').invoke(guest, {})
  );
  const readFollower = toolNamed(tools, 'readFollower');
  const read = /** @type {any} */ (
    await readFollower.invoke(guest, { follower, maxItems: 4 })
  );
  t.deepEqual(read.items, ['one']);
  t.true(read.done);
  t.regex(read.error, /stream broke/);
  await t.throwsAsync(async () => readFollower.invoke(guest, { follower }), {
    message: /No open follower/,
  });
});

test('every declared schema property is closed over', t => {
  for (const { name, inputSchema } of makeAgentTools()) {
    t.is(
      /** @type {any} */ (inputSchema).additionalProperties,
      false,
      `${name} rejects undeclared arguments`,
    );
  }
});

/**
 * A value the JSON Schema accepts, for building an otherwise valid call.
 *
 * @param {any} schema
 * @returns {unknown}
 */
const sampleFor = schema => {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'string':
      return 'x';
    case 'boolean':
      return true;
    case 'integer':
      return schema.minimum ?? 1;
    case 'array':
      return [sampleFor(schema.items)];
    case 'object':
      return {};
    default:
      return 'x';
  }
};

/**
 * Whether the adapter's argument-scope gate admits a call: the Pattern, then
 * the tool's own normalizer.
 *
 * @param {ToolDeclaration<any>} tool
 * @param {Record<string, unknown>} toolArguments
 */
const admits = (tool, toolArguments) => {
  const hardened = harden(toolArguments);
  if (!matches(hardened, tool.argumentsShape)) {
    return false;
  }
  try {
    tool.normalizeArguments?.(hardened);
  } catch {
    return false;
  }
  return true;
};

test('every integer schema bound is enforced by the argument-scope gate', t => {
  let checked = 0;
  for (const tool of makeAgentTools()) {
    const { properties, required = [] } = /** @type {any} */ (tool.inputSchema);
    const base = Object.fromEntries(
      required.map(key => [key, sampleFor(properties[key])]),
    );
    const integerProperties = Object.entries(properties).filter(
      ([_key, schema]) => [schema.type].flat().includes('integer'),
    );
    for (const [key, schema] of integerProperties) {
      checked += 1;
      const valid = schema.minimum ?? 1;
      t.true(admits(tool, { ...base, [key]: valid }), `${tool.name}.${key}`);
      const invalid = [valid + 0.5];
      if (schema.minimum !== undefined) {
        invalid.push(schema.minimum - 1);
      }
      if (schema.maximum !== undefined) {
        invalid.push(schema.maximum + 1);
      }
      for (const value of invalid) {
        t.false(
          admits(tool, { ...base, [key]: value }),
          `${tool.name}.${key} refuses ${value}`,
        );
      }
    }
  }
  t.true(checked > 0);
});

test('makeMcpConfig names one server and carries only the formula id in env', t => {
  const formulaId = 'ab'.repeat(32);
  t.deepEqual(makeMcpConfig({ formulaId }), {
    mcpServers: {
      endo: {
        command: 'endo-mcp-stdio',
        args: [],
        env: { ENDO_GUEST_FORMULA_ID: formulaId },
      },
    },
  });
  t.deepEqual(
    makeMcpConfig({ formulaId, endoSock: '/run/endo.sock' }).mcpServers.endo
      .env,
    { ENDO_GUEST_FORMULA_ID: formulaId, ENDO_SOCK: '/run/endo.sock' },
  );
  t.throws(() => makeMcpConfig({ formulaId: 'nope' }), {
    message: /64-character/,
  });
});

/**
 * A stand-in for one declared argument, derived from its JSON schema and
 * distinct per argument name, so a swapped or dropped argument shows in the
 * recorded call.
 *
 * @param {string} name
 * @param {Record<string, any>} schema
 * @returns {unknown}
 */
const sampleArgument = (name, schema) => {
  if (schema.anyOf) return sampleArgument(name, schema.anyOf[0]);
  const types = [schema.type].flat();
  if (types.includes('integer')) return name.length;
  if (types.includes('boolean')) return true;
  if (types.includes('object')) return { [name]: 'value' };
  if (types.includes('array')) return [sampleArgument(name, schema.items)];
  return name;
};

/**
 * A guest whose every method records its call. Mounts looked up through it
 * record the same way, so search tools reach a call too. With `streams`, every
 * method instead answers an empty reader, for the tools that open a follower.
 *
 * @param {unknown[][]} calls
 * @param {boolean} [streams]
 * @returns {any}
 */
const makeRecordingGuest = (calls, streams = false) =>
  new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== 'string' || name === 'then') return undefined;
        return (/** @type {unknown[]} */ ...methodArguments) => {
          calls.push([name, ...methodArguments]);
          if (streams) return readerFromIterator([][Symbol.iterator]());
          return name === 'lookup' ? makeRecordingGuest(calls) : 'ok';
        };
      },
    },
  );

/**
 * The guest calls each tool makes, as `[method, ...arguments]`, for its
 * required arguments and, where different, for all of them. Pins the method
 * each tool reaches and the order its arguments arrive in.
 *
 * @type {Record<string, [unknown[][], unknown[][]?]>}
 */
const expectedGuestCalls = {
  help: [[['help']], [['help', 'methodName']]],
  has: [[['has', 'petNamePath']]],
  list: [[['list']], [['list', 'petNamePath']]],
  remove: [[['remove', 'petNamePath']]],
  move: [[['move', ['fromPath'], ['toPath']]]],
  copy: [[['copy', ['fromPath'], ['toPath']]]],
  identify: [[['identify', 'petNamePath']]],
  reverseIdentify: [[['reverseIdentify', 'identifier']]],
  listIdentifiers: [
    [['listIdentifiers']],
    [['listIdentifiers', 'petNamePath']],
  ],
  storeIdentifier: [[['storeIdentifier', ['petNamePath'], 'identifier']]],
  locate: [[['locate', 'petNamePath']]],
  listLocators: [[['listLocators']], [['listLocators', 'petNamePath']]],
  reverseLocate: [[['reverseLocate', 'locator']]],
  storeLocator: [[['storeLocator', ['petNamePath'], 'locator']]],
  locateContent: [[['locateContent', 'petNamePath']]],
  listContent: [[['listContent']], [['listContent', 'petNamePath']]],
  storeContent: [[['storeContent', 'petNamePath']]],
  reverseLocateContent: [[['reverseLocateContent', 'locator']]],
  internalizeContentLocator: [[['internalizeContentLocator', 'locator']]],
  loadContent: [[['loadContent', 'locator']]],
  invite: [[['invite', ['petNamePath']]]],
  accept: [[['accept', 'locator', ['petNamePath']]]],
  makeDirectory: [[['makeDirectory', ['petNamePath']]]],
  makePath: [[['has', 'petNamePath']]],
  readText: [[['readText', ['petNamePath']]]],
  maybeReadText: [[['maybeReadText', ['petNamePath']]]],
  writeText: [[['writeText', ['petNamePath'], 'text']]],
  storeValue: [[['storeValue', 'value', ['petNamePath']]]],
  glob: [
    [
      ['lookup', ['mountPath']],
      ['glob', 'pattern', {}],
    ],
    [
      ['lookup', ['mountPath']],
      ['glob', 'pattern', { followSymlinks: true }],
    ],
  ],
  grep: [
    [
      ['lookup', ['mountPath']],
      ['grep', 'pattern', undefined, {}],
    ],
    [
      ['lookup', ['mountPath']],
      ['grep', 'pattern', ['paths'], { maxResults: 10, followSymlinks: true }],
    ],
  ],
  glorp: [
    [
      ['lookup', ['mountPath']],
      ['glorp', 'globPattern', 'grepPattern', {}],
    ],
    [
      ['lookup', ['mountPath']],
      [
        'glorp',
        'globPattern',
        'grepPattern',
        { maxResults: 10, followSymlinks: true },
      ],
    ],
  ],
  evaluate: [
    [['evaluate', undefined, 'source', ['codeNames'], [['petNamePaths']]]],
    [
      [
        'evaluate',
        ['workerName'],
        'source',
        ['codeNames'],
        [['petNamePaths']],
        ['resultName'],
      ],
    ],
  ],
  define: [[['define', 'source', { slots: 'value' }]]],
  listMessages: [[['listMessages']]],
  send: [[['send', ['recipient'], ['strings'], ['edgeNames'], [['petNames']]]]],
  reply: [[['reply', 13n, ['strings'], ['edgeNames'], [['petNames']]]]],
  editMessage: [
    [['editMessage', 13n, ['strings'], ['edgeNames'], [['petNames']]]],
    [
      [
        'editMessage',
        13n,
        ['strings'],
        ['edgeNames'],
        [['petNames']],
        { done: true },
      ],
    ],
  ],
  messageHistory: [[['messageHistory', 13n]]],
  adopt: [[['adopt', 13n, 'edgeName', ['petName']]]],
  dismiss: [[['dismiss', 13n]]],
  dismissAll: [[['dismissAll']]],
  request: [
    [['request', ['recipient'], 'description']],
    [['request', ['recipient'], 'description', ['responseName']]],
  ],
  resolve: [[['resolve', 13n, ['petNamePath']]]],
  reject: [[['reject', 13n]], [['reject', 13n, 'reason']]],
  sendValue: [[['sendValue', 13n, ['petNamePath']]]],
  form: [[['form', ['recipient'], 'description', [{ fields: 'value' }]]]],
  submit: [[['submit', 13n, { values: 'value' }]]],
  followMessages: [[['followMessages']]],
  followNameChanges: [[['followNameChanges']]],
  followLocatorNameChanges: [[['followLocatorNameChanges', 'locator']]],
  followStream: [[['lookup', ['petNamePath']]]],
};

for (const scope of ['required', 'all']) {
  test(`every tool reaches the guest with ${scope} arguments`, async t => {
    const tools = makeAgentTools();
    const catalog = makeToolCatalog(tools);
    // The follower tools take a handle, not a guest method; the stream tests
    // above cover them.
    const guestTools = tools.filter(
      ({ name }) => name !== 'readFollower' && name !== 'closeFollower',
    );
    t.deepEqual(
      guestTools.map(({ name }) => name),
      Object.keys(expectedGuestCalls),
    );
    for (const tool of guestTools) {
      const { properties = {}, required = [] } = /** @type {any} */ (
        tool.inputSchema
      );
      const names = scope === 'required' ? required : Object.keys(properties);
      const toolArguments = Object.fromEntries(
        names.map((/** @type {string} */ name) => [
          name,
          sampleArgument(name, properties[name]),
        ]),
      );
      t.true(catalog.names.includes(tool.name), tool.name);
      /** @type {unknown[][]} */
      const calls = [];
      const normalized = tool.normalizeArguments
        ? tool.normalizeArguments(harden(toolArguments))
        : harden(toolArguments);
      // eslint-disable-next-line no-await-in-loop
      await tool.invoke(
        makeRecordingGuest(calls, tool.name.startsWith('follow')),
        normalized,
      );
      const [requiredCalls, allCalls = requiredCalls] =
        expectedGuestCalls[tool.name];
      t.deepEqual(
        calls,
        scope === 'required' ? requiredCalls : allCalls,
        tool.name,
      );
    }
  });
}
