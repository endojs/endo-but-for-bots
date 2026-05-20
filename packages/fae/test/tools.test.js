// @ts-check
/* global process */

import '@endo/init/debug.js';

import test from 'ava';

import { discoverTools, executeTool } from '../src/tools.js';

/**
 * Build an in-memory FaeTool stub whose `schema()` declares the given
 * intrinsic function name and whose `execute()` resolves to `result`.
 *
 * @param {string} toolName
 * @param {string} result
 */
const makeTool = (toolName, result) =>
  harden({
    schema() {
      return harden({
        type: 'function',
        function: {
          name: toolName,
          description: `${toolName} test tool`,
          parameters: { type: 'object', properties: {}, required: [] },
        },
      });
    },
    async execute() {
      return result;
    },
    help() {
      return `${toolName} help`;
    },
  });

/**
 * Build a minimal host stub that satisfies the `list('tools')` and
 * `lookup(['tools', petName])` calls discoverTools makes.
 *
 * @param {Record<string, ReturnType<typeof makeTool>>} toolsByPetName
 */
const makeHost = toolsByPetName =>
  harden({
    /** @param {string} directory */
    async list(directory) {
      return directory === 'tools' ? Object.keys(toolsByPetName) : [];
    },
    /** @param {string[]} path */
    async lookup(path) {
      return toolsByPetName[path[1]];
    },
  });

test('kebab-case petname is exposed as camelCase function name', async t => {
  const remoteTool = makeTool('timestamp', 'sentinel');
  const { schemas, toolMap } = await discoverTools(
    makeHost({ 'timestamp-tool': remoteTool }),
    new Map(),
  );

  t.deepEqual(
    schemas.map(schema => schema.function.name),
    ['timestampTool'],
    'schema function name is rewritten to camelCase',
  );
  t.true(toolMap.has('timestampTool'));
  t.false(
    toolMap.has('timestamp-tool'),
    'kebab petname should not be a dispatch key on the tool surface',
  );
  t.is(await executeTool('timestampTool', {}, toolMap), 'sentinel');
});

test('same underlying tool adopted under two petnames yields two callable entries', async t => {
  const remoteTool = makeTool('readFile', 'sentinel');
  const { schemas, toolMap } = await discoverTools(
    makeHost({
      'read-file-a': remoteTool,
      'read-file-b': remoteTool,
    }),
    new Map(),
  );

  const names = schemas.map(schema => schema.function.name).sort();
  t.deepEqual(
    names,
    ['readFileA', 'readFileB'],
    'both translated petnames appear as distinct entries in the schema list',
  );
  t.true(toolMap.has('readFileA'));
  t.true(toolMap.has('readFileB'));

  const resultA = await executeTool('readFileA', {}, toolMap);
  const resultB = await executeTool('readFileB', {}, toolMap);
  t.is(resultA, 'sentinel');
  t.is(resultB, resultA, 'both petnames execute the same underlying tool');
});

test('mixed-case and underscore petnames pass through unchanged', async t => {
  const camelTool = makeTool('readFile', 'camel');
  const underscoreTool = makeTool('read_file', 'underscore');
  const { schemas, toolMap } = await discoverTools(
    makeHost({
      readFile: camelTool,
      read_file: underscoreTool,
    }),
    new Map(),
  );

  t.deepEqual(schemas.map(schema => schema.function.name).sort(), [
    'readFile',
    'read_file',
  ]);
  t.is(await executeTool('readFile', {}, toolMap), 'camel');
  t.is(await executeTool('read_file', {}, toolMap), 'underscore');
});

test('illegal-OpenAI-name petname falls back to intrinsic schema name and warns', async t => {
  const remoteTool = makeTool('readFile', 'sentinel');
  /** @type {string[]} */
  const warnings = [];
  // SES freezes the console object, so wrap stderr.write instead.
  const originalWrite = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line no-underscore-dangle
  process.stderr.write = /** @type {any} */ (
    (/** @type {string | Uint8Array} */ chunk, ...rest) => {
      warnings.push(typeof chunk === 'string' ? chunk : String(chunk));
      return originalWrite(chunk, .../** @type {any[]} */ (rest));
    }
  );
  t.teardown(() => {
    process.stderr.write = originalWrite;
  });

  const { schemas, toolMap } = await discoverTools(
    // Spaces are not allowed in OpenAI function names — exercises fallback.
    makeHost({ 'read file': remoteTool }),
    new Map(),
  );

  t.deepEqual(
    schemas.map(schema => schema.function.name),
    ['readFile'],
    'falls back to the intrinsic schema name when petname is illegal',
  );
  t.true(toolMap.has('readFile'));
  t.false(toolMap.has('read file'));
  t.is(await executeTool('readFile', {}, toolMap), 'sentinel');
  t.true(
    warnings.some(
      msg =>
        msg.includes('read file') &&
        msg.includes('not a legal OpenAI function name'),
    ),
    'a fallback warning was emitted',
  );
});
