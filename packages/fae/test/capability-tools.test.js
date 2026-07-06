// @ts-check

/**
 * Unit tests for the Phase 4 capability-tool adapter that bridges
 * `@endo/agent-tools` ToolRecords into Fae's `{ schema, execute, help }`
 * FaeTool shape and registers them from an agent's granted capabilities.
 *
 * These don't require a running daemon or LLM — the `powers` and capabilities
 * are stubbed.
 */

import '@endo/init/debug.js';

import test from 'ava';
import { Far } from '@endo/pass-style';

import {
  toFaeTool,
  registerCapabilityTools,
} from '../src/capability-tools.js';

const makeStubShell = () =>
  Far('StubShell', {
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    inspect: async () => ({}),
  });

const makePowers = (/** @type {Record<string, unknown>} */ grants) =>
  Far('StubPowers', {
    lookup: async (/** @type {string[]} */ namePath) => {
      const [name] = namePath;
      if (Object.prototype.hasOwnProperty.call(grants, name)) {
        return grants[name];
      }
      throw new Error(`Not found: ${name}`);
    },
  });

test('toFaeTool exposes the record as an OpenAI function schema', t => {
  const record = harden({
    name: 'demo',
    description: 'A demo tool.',
    parameters: { type: 'object', properties: {} },
    inputSchema: { type: 'object', properties: {} },
    invoke: async () => 'ok',
  });
  const faeTool = toFaeTool(record);
  const schema = faeTool.schema();
  t.is(schema.type, 'function');
  t.is(schema.function.name, 'demo');
  t.is(schema.function.description, 'A demo tool.');
  t.is(faeTool.help(), 'A demo tool.');
});

test('toFaeTool.execute passes strings through', async t => {
  const record = harden({
    name: 'echo',
    description: '',
    parameters: {},
    inputSchema: {},
    invoke: async (/** @type {any} */ args) => `got:${args.x}`,
  });
  const result = await toFaeTool(record).execute({ x: 'hi' });
  t.is(result, 'got:hi');
});

test('toFaeTool.execute JSON-stringifies non-string results', async t => {
  const record = harden({
    name: 'rows',
    description: '',
    parameters: {},
    inputSchema: {},
    invoke: async () => [{ path: 'a', index: 'modified' }],
  });
  const result = await toFaeTool(record).execute({});
  t.is(result, JSON.stringify([{ path: 'a', index: 'modified' }]));
});

test('registerCapabilityTools adds only the granted capability tools', async t => {
  /** @type {Map<string, any>} */
  const localTools = new Map();
  localTools.set('reply', Far('reply', { schema: () => ({}) }));
  const registered = await registerCapabilityTools(
    makePowers({ shell: makeStubShell() }),
    localTools,
  );
  t.deepEqual(registered.sort(), ['exec', 'inspect']);
  t.true(localTools.has('exec'));
  t.true(localTools.has('inspect'));
  t.true(localTools.has('reply')); // pre-existing entries untouched
  // The registered entries are FaeTools with a callable schema().
  const execSchema = localTools.get('exec').schema();
  t.is(execSchema.function.name, 'exec');
});

test('registerCapabilityTools adds nothing when no capabilities granted', async t => {
  /** @type {Map<string, any>} */
  const localTools = new Map();
  const registered = await registerCapabilityTools(
    makePowers({}),
    localTools,
  );
  t.deepEqual(registered, []);
  t.is(localTools.size, 0);
});
