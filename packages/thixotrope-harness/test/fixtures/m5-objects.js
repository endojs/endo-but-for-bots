// @ts-check
/**
 * M5 fixture objects (W5.4; `designs/m5-interfaces.md` 7, section 10): the
 * objects M5's integration tests and perf checks endow, mention, grant and
 * inspect. `makeFixtures` is shipped by its source text: it is evaluated in
 * the harness workspace vat (`client.call('evaluate', ...)`, prelude names
 * only: `Far`, `harden`, `makePromiseKit`), and the same text is evaluated
 * in a Node compartment with the guest prelude by the unit tests
 * (`m5-w54-*.test.js`), so both run one implementation.
 *
 * The objects (`all()` answers them in one record):
 * - `notes`, `calc`: plain objects with `help`; `notes.calls()` is the log
 *   of every other method called on it (acceptance 3: `lookup` renders an
 *   object without calling its methods);
 * - `sourceReader`: a `SourceReader` over a small in-memory tree
 *   (`README.md`, `src/agent.js`) with Fae's per-item rules (start line,
 *   line count, literal search, 8,000 characters);
 * - `echoTool` (`echo2`), `tools.make(name)` (a tool of any name: `exec`
 *   for `refused-builtin`, two `t` for `refused-duplicate`);
 * - hostile granted tools: `badSchemaTool` (not a function schema),
 *   `deepSchemaTool` (parameters 34 values deep, the inspector's
 *   bound is 32), `bigSchemaTool`
 *   (parameters of about 3,000 units, probe e), `bigAnswerTool` (answers
 *   300,000 characters), `throwingTool`;
 * - `bigHelp` (`help()` answers 200,000 characters, probe b);
 * - `keyFlood` (`help()` answers a record of 20,000 distinct keys, probe c;
 *   built on first call, so it costs the workspace vat's name table nothing
 *   until a test asks: then about 20,000 of its about 57,000 names, once);
 * - `slowTool` (`slow`): `execute` starts a run and answers when
 *   `release()` is called; `runs()` answers `{ started, finished }` (K5).
 *
 * Nothing here is a secret or looks like one.
 */
import { E } from '@endo/far';

/** The inventory name the workspace keeps the fixtures under. */
export const m5FixtureName = 'm5Fixtures';

/**
 * Make the fixtures. Shipped by source: uses prelude names only.
 * @returns {any}
 */
export const makeFixtures = () => {
  // Prelude names (globals in the vat and in the unit tests' compartment).
  const { Far, makePromiseKit } = /** @type {any} */ (globalThis);
  /** @param {string} name */
  const toolSchema = name =>
    harden({
      type: 'function',
      function: {
        name,
        description: `The ${name} fixture tool: echoes its text argument.`,
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    });
  /** @param {string} name */
  const makeTool = name =>
    Far(`tool ${name}`, {
      schema: () => toolSchema(name),
      /** @param {{ text?: unknown }} args */
      execute: args => `${name}: ${args?.text}`,
      help: () => `A fixture tool named ${name}.`,
    });

  /** @type {string[]} */
  const noteCalls = [];
  /** @param {string} name */
  const logCall = name => {
    noteCalls.push(name);
    if (noteCalls.length > 100) noteCalls.shift();
  };
  let noteText = 'remember the milk';
  const notes = Far('notes', {
    read: () => {
      logCall('read');
      return noteText;
    },
    /** @param {string} text */
    write: text => {
      logCall('write');
      noteText = String(text).slice(0, 1000);
    },
    /** @param {string} [method] */
    help: method => {
      logCall('help');
      return method === undefined
        ? 'notes: read() answers the note; write(text) replaces it.'
        : `notes.${method}: see read() and write(text).`;
    },
    calls: () => harden([...noteCalls]),
  });
  const calc = Far('calc', {
    /**
     * @param {number} a
     * @param {number} b
     */
    add: (a, b) => a + b,
    help: () => 'calc: add(a, b) answers a + b.',
  });

  const files = new Map([
    [
      'README.md',
      Array.from({ length: 40 }, (_, i) => `README line ${i + 1}`).join('\n'),
    ],
    [
      'src/agent.js',
      [
        '// agent',
        'export const run = () => {',
        '  checkpoint();',
        '  return 1;',
        '};',
        'const checkpoint = () => undefined;',
      ].join('\n'),
    ],
  ]);
  const sourceReader = Far('SourceReader', {
    /** @param {{ path: string[], startLine?: number, lineCount?: number, search?: string }} request */
    read: ({ path, startLine = 1, lineCount = 80, search }) => {
      const text = files.get(path.join('/'));
      if (text === undefined)
        return harden({ ok: false, error: 'No such file' });
      const source = text.split('\n');
      /** @type {{ line: number, text: string }[]} */
      const lines = [];
      let characters = 0;
      let outputTruncated = false;
      for (let at = startLine - 1; at < source.length; at += 1) {
        const line = source[at];
        // eslint-disable-next-line no-continue
        if (search !== undefined && !line.includes(search)) continue;
        if (lines.length === lineCount || characters === 8000) {
          outputTruncated = true;
          break;
        }
        const rendered = line.slice(0, 8000 - characters);
        characters += rendered.length;
        lines.push({ line: at + 1, text: rendered });
      }
      return harden({ ok: true, lines, scanTruncated: false, outputTruncated });
    },
    help: () => 'SourceReader: read({ path, startLine, lineCount, search }).',
  });

  /**
   * @param {string} name
   * @param {() => any} schema
   * @param {(args: any) => any} [execute]
   */
  const hostileTool = (name, schema, execute = () => 'ok') =>
    Far(`tool ${name}`, { schema, execute });
  /** @param {number} depth */
  const nested = depth => {
    /** @type {any} */
    let value = { type: 'string' };
    for (let i = 0; i < depth; i += 1)
      value = { type: 'object', properties: { a: value } };
    return value;
  };
  const badSchemaTool = hostileTool('bad', () =>
    harden({ type: 'nope', function: { name: 'bad' } }),
  );
  const deepSchemaTool = hostileTool('deep', () =>
    harden({
      type: 'function',
      // 16 levels put the innermost value at depth 34 (> SCHEMA_DEPTH 32).
      // 40 (about 80 nested records) overflowed the workspace vat's stack
      // while it sent its own answer: StackOverflow halted it (J-9693).
      function: { name: 'deep', description: 'deep', parameters: nested(16) },
    }),
  );
  const bigSchemaTool = hostileTool('big', () =>
    harden({
      type: 'function',
      function: {
        name: 'bigSchema',
        description: 'big',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: 'x'.repeat(3000) } },
        },
      },
    }),
  );
  const bigAnswerTool = hostileTool(
    'bigAnswer',
    () => toolSchema('bigAnswer'),
    () => 'y'.repeat(300_000),
  );
  const throwingTool = hostileTool(
    'throwing',
    () => toolSchema('throwing'),
    () => {
      throw Error('the throwing fixture tool failed');
    },
  );
  const bigHelp = Far('bigHelp', {
    help: () => 'h'.repeat(200_000),
  });
  /** @type {any} */
  let flood;
  const keyFlood = Far('keyFlood', {
    help: () => {
      if (flood === undefined) {
        /** @type {[string, number][]} */
        const entries = [];
        for (let i = 0; i < 20_000; i += 1) entries.push([`k${i}`, i]);
        flood = harden(Object.fromEntries(entries));
      }
      return flood;
    },
  });

  let started = 0;
  let finished = 0;
  /** @type {(() => void)[]} */
  const waiting = [];
  const slowTool = Far('tool slow', {
    schema: () => toolSchema('slow'),
    /** @param {{ text?: unknown }} args */
    execute: args => {
      started += 1;
      const { promise, resolve } = makePromiseKit();
      waiting.push(() => {
        finished += 1;
        resolve(`slow: ${args?.text}`);
      });
      return promise;
    },
    release: () => {
      for (const release of waiting.splice(0)) release();
    },
    runs: () => harden({ started, finished }),
  });

  const tools = Far('tools', {
    /** @param {string} name */
    make: name => makeTool(name),
  });
  const echoTool = makeTool('echo2');

  const all = harden({
    notes,
    calc,
    sourceReader,
    echoTool,
    tools,
    badSchemaTool,
    deepSchemaTool,
    bigSchemaTool,
    bigAnswerTool,
    throwingTool,
    bigHelp,
    keyFlood,
    slowTool,
  });
  return Far('M5Fixtures', { all: () => all });
};

/** The expression the workspace vat evaluates. */
export const m5FixtureSource = `(${makeFixtures})`;

/**
 * Put the fixtures into the workspace inventory once and answer them
 * (`all()`): a record of presences. Node only.
 * @param {any} client a control client on the harness workspace
 */
export const makeM5Fixtures = async client => {
  const found = await client.call('lookup', m5FixtureName);
  if (found === undefined) {
    await client.call(
      'evaluate',
      `(inventory.set(${JSON.stringify(m5FixtureName)}, ${m5FixtureSource}()), true)`,
    );
  }
  const fixtures = await client.call('lookup', m5FixtureName);
  return E(fixtures).all();
};
