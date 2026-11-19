// @ts-check
// W5.3 (designs/m5-interfaces.md 2.4.1, 2.4.3, 2.5, 2.8 S1): the label map
// and its bounds, the seeds, the local object tools over a fake
// ToolContext, and the per-round tool set with the built-in name rules.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { textOf, reservedLabels } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { seedsFor } from '../../guest/session/label-seeds.js';
import { isValidLabel, makeLabels } from '../../guest/session/labels.js';
import {
  makeRuntime,
  requiredParts,
} from '../../guest/session/runtime-parts.js';
import {
  builtInToolNames,
  toolSetFor,
  toolTable,
} from '../../guest/session/tool-table.js';
import {
  capabilityLine,
  objectToolDescriptions,
  objectToolEntries,
} from '../../guest/session/tools/objects.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far } = /** @type {GuestGlobals} */ (globalThis);

const notes = Far('Notes', { read: () => 'n' });

// ---------------------------------------------------------------- labels

test('labels follow the endowment rule (R3-22)', t => {
  for (const ok of ['notes', 'a b', 'x'.repeat(80), 'café', '...']) {
    t.true(isValidLabel(ok), ok);
  }
  for (const bad of [
    '',
    '   ',
    'x'.repeat(81),
    'a@b',
    'a/b',
    'a\nb',
    '.',
    '..',
    ...reservedLabels,
  ]) {
    t.false(isValidLabel(bad), JSON.stringify(bad));
  }
  const labels = makeLabels();
  t.throws(() => labels.bindJson('user', '1'), {
    message: textOf.reservedLabel('user'),
  });
  t.throws(() => labels.bindObject('a/b', notes, 'adopted'), {
    message: textOf.reservedLabel('a/b'),
  });
});

test('no silent overwrite; remove frees the label', t => {
  const labels = makeLabels();
  labels.bindJson('x', '1');
  t.throws(() => labels.bindJson('x', '2'), {
    message: textOf.labelTaken('x'),
  });
  t.throws(() => labels.bindObject('x', notes, 'stored'), {
    message: textOf.labelTaken('x'),
  });
  t.true(labels.remove('x'));
  t.false(labels.remove('x'));
  labels.bindJson('x', '2');
  t.deepEqual(labels.get('x'), { kind: 'json', text: '2', bytes: 1 });
});

test('256 labels at most; a removal frees a slot', t => {
  const labels = makeLabels();
  for (let i = 0; i < limits.maxLabels; i += 1) labels.bindJson(`k${i}`, '1');
  t.is(labels.size(), 256);
  t.throws(() => labels.bindJson('one-more', '1'), {
    message: textOf.labelsFull(256),
  });
  labels.remove('k7');
  labels.bindObject('one-more', notes, 'adopted');
  t.is(labels.size(), 256);
  t.deepEqual(labels.list().slice(0, 3), ['k0', 'k1', 'k10']);
  t.true(labels.list().includes('one-more'));
});

test('stored values: 8,192 bytes each (UTF-8), 262,144 bytes in all', t => {
  const labels = makeLabels();
  labels.bindJson('ok', `"${'x'.repeat(8190)}"`);
  t.throws(() => labels.bindJson('big', `"${'x'.repeat(8191)}"`), {
    message: textOf.valueTooLarge(8193, 8192),
  });
  // Three-byte characters count as three bytes.
  t.throws(() => labels.bindJson('wide', '中'.repeat(2731)), {
    message: textOf.valueTooLarge(8193, 8192),
  });
  const full = makeLabels();
  const value = 'x'.repeat(8192);
  for (let i = 0; i < 32; i += 1) full.bindJson(`v${i}`, value);
  t.is(full.jsonBytes(), 262_144);
  t.throws(() => full.bindJson('v32', '1'), {
    message: textOf.storedValuesFull(262_144),
  });
  full.remove('v0');
  t.is(full.jsonBytes(), 262_144 - 8192);
  full.bindJson('v32', '1');
  // Objects take no JSON bytes.
  full.bindObject('o', notes, 'stored');
  t.is(full.jsonBytes(), 262_144 - 8191);
});

test('seeds: endowments first, then the label-seeds table; a taken seed fails', t => {
  const calc = Far('Calc', {});
  const seeds = seedsFor(
    harden({ endowments: [{ label: 'notes', value: notes }] }),
    harden({}),
    harden([
      { label: 'calc', from: () => calc },
      { label: 'none', from: () => undefined },
    ]),
  );
  t.deepEqual(
    seeds.map(s => [s.label, s.source]),
    [
      ['notes', 'endowment'],
      ['calc', 'preset'],
    ],
  );
  const labels = makeLabels({ seeds });
  t.deepEqual(labels.list(), ['calc', 'notes']);
  t.is(/** @type {any} */ (labels.get('notes')).value, notes);
  t.throws(() =>
    makeLabels({
      seeds: seedsFor(
        harden({
          endowments: [
            { label: 'notes', value: notes },
            { label: 'notes', value: calc },
          ],
        }),
        harden({}),
      ),
    }),
  );
  t.deepEqual(seedsFor(harden({}), harden({})), []);
});

test('method names are cached beside an object binding', t => {
  const labels = makeLabels();
  const binding = labels.bindObject('notes', notes, 'endowment');
  t.is(labels.methodsOf(binding), undefined);
  labels.setMethods(binding, ['read']);
  t.deepEqual(labels.methodsOf(binding), ['read']);
});

// ---------------------------------------------------------------- tools

/**
 * @param {import('../../guest/session/labels.js').Labels} labels
 * @param {any} [inspector]
 */
const contextOf = (labels, inspector) =>
  harden({
    runtime: makeRuntime({
      labels,
      services: harden({}),
      config: harden({}),
      // The object tools read only `labels` and `inspector`; the other
      // required parts are empty stand-ins.
      parts: harden(
        requiredParts.map(name => ({
          name,
          make: () =>
            name === 'inspector' && inspector !== undefined
              ? inspector
              : harden({}),
        })),
      ),
    }),
  });

const entry = (/** @type {string} */ name) =>
  /** @type {any} */ (objectToolEntries.find(e => e.name === name));

/**
 * @param {string} name
 * @param {any} args
 * @param {any} context
 */
const run = (name, args, context) =>
  entry(name).execute(harden({ opId: 'o1', args, turnId: 't1' }), {}, context);

test('object tools: list, store, lookup of JSON, remove (Fae texts)', async t => {
  const labels = makeLabels({
    seeds: harden([{ label: 'notes', value: notes, source: 'endowment' }]),
  });
  const context = contextOf(labels);
  t.deepEqual(await run('list', '{}', context), {
    status: 'ok',
    text: JSON.stringify(['notes'], null, 2),
  });
  t.deepEqual(
    await run('store', '{"value": {"a": [1, 2]}, "petName": "x"}', context),
    { status: 'ok', text: 'Stored value under "x"' },
  );
  t.deepEqual(await run('lookup', '{"petName":"x"}', context), {
    status: 'ok',
    text: '{"a": [1, 2]}',
  });
  t.deepEqual(await run('list', '', context), {
    status: 'ok',
    text: JSON.stringify(['notes', 'x'], null, 2),
  });
  t.deepEqual(await run('remove', '{"petName":"x"}', context), {
    status: 'ok',
    text: 'Removed "x"',
  });
  t.deepEqual(await run('lookup', '{"petName":"x"}', context), {
    status: 'failed',
    text: textOf.unknownLabel('x'),
  });
  t.deepEqual(await run('remove', '{"petName":"x"}', context), {
    status: 'failed',
    text: textOf.unknownLabel('x'),
  });
  // Refusals of the label map are failed results.
  await run('store', '{"value":1,"petName":"y"}', context);
  t.deepEqual(await run('store', '{"value":2,"petName":"y"}', context), {
    status: 'failed',
    text: textOf.labelTaken('y'),
  });
  t.deepEqual(await run('store', '{"value":2,"petName":"user"}', context), {
    status: 'failed',
    text: textOf.reservedLabel('user'),
  });
});

test('object tools refuse unknown keys, odd JSON and staged arguments', async t => {
  const context = contextOf(makeLabels());
  t.deepEqual(await run('lookup', '{"petName":"x","method":"m"}', context), {
    status: 'failed',
    text: textOf.unexpectedArgument('method', 'lookup', ['petName']),
  });
  const notJson = await run('store', '{"petName":"x"}', context);
  t.is(notJson.status, 'failed');
  t.regex(notJson.text, /^could not parse tool arguments as JSON/);
  const staged = harden({
    blob: Far('Blob', {}),
    preview: '{"value":',
    bytes: 9000,
  });
  t.deepEqual(await run('store', staged, context), {
    status: 'failed',
    text: textOf.argumentsTooLarge('store', 9000, limits.inlineBytes),
  });
});

test('lookup of an object: cached names, else the inspector part, never a method call', async t => {
  let called = 0;
  const target = Far('Target', {
    poke: () => {
      called += 1;
    },
  });
  const labels = makeLabels({
    seeds: harden([{ label: 't', value: target, source: 'endowment' }]),
  });
  /** @type {any[]} */
  const asked = [];
  const inspector = harden({
    lookup: async (/** @type {any} */ request) => {
      asked.push(request);
      labels.setMethods(request.binding, ['poke']);
      return harden({ status: 'ok', text: capabilityLine(['poke']) });
    },
  });
  const context = contextOf(labels, inspector);
  const expected = {
    status: 'ok',
    text: '[remote capability] callable methods: ["poke"]',
  };
  t.deepEqual(await run('lookup', '{"petName":"t"}', context), expected);
  t.deepEqual(await run('lookup', '{"petName":"t"}', context), expected);
  t.is(asked.length, 1, 'the second lookup used the cache');
  t.is(asked[0].label, 't');
  t.is(asked[0].binding.value, target);
  t.is(called, 0);
});

test('object tool sites and descriptions', t => {
  t.deepEqual(
    objectToolEntries.map(e => [e.name, e.site]),
    [
      ['list', 'session'],
      ['lookup', 'guest'],
      ['store', 'session'],
      ['remove', 'session'],
    ],
  );
  for (const e of objectToolEntries) {
    const d = e.describe();
    t.is(d, /** @type {any} */ (objectToolDescriptions)[e.name]);
    t.true(e.available({}, {}));
    t.notThrows(() => JSON.parse(d.parameters));
    t.true(d.description.length <= limits.toolDescriptionUnits);
  }
  // W5.5 and W5.7 append their entries after W5.3's (hook table H-5).
  t.deepEqual(
    toolTable.map(e => e.name),
    [
      'echo',
      'exec',
      'list',
      'lookup',
      'store',
      'remove',
      'describeCapability',
      'readSources',
      'adopt',
      'adoptTool',
      'runCommand',
      'inspectShell',
    ],
  );
});

// ---------------------------------------------------------------- tool sets

/**
 * A dynamic entry for a source.
 * @param {string} name
 * @param {any[]} [log]
 * @returns {any}
 */
const dynamic = (name, log = []) =>
  harden({
    name,
    site: 'guest',
    describe: () => harden({ name, description: name, parameters: '{}' }),
    available: () => true,
    execute: async () => harden({ status: 'ok', text: name }),
    refused: (/** @type {string} */ state, /** @type {string} */ reason) =>
      log.push([name, state, reason]),
  });

test('toolSetFor: dynamic sources after the table; built-in and duplicate names refused', t => {
  const accountStatus = harden({
    name: 'accountStatus',
    tool: Far('AdapterTool', {}),
  });
  const portsWith = harden({ tools: [accountStatus] });
  const portsWithout = harden({ tools: [] });
  /** @type {any[]} */
  const log = [];
  const source = () =>
    harden([
      dynamic('echo2', log),
      dynamic('exec', log),
      dynamic('accountStatus', log),
      dynamic('t', log),
      dynamic('t', log),
    ]);
  const set = toolSetFor(
    portsWith,
    toolTable,
    {},
    harden({ toolSources: [source] }),
  );
  t.deepEqual(
    set.descriptions.map((/** @type {any} */ d) => d.name),
    ['list', 'lookup', 'store', 'remove', 'adopt', 'echo2'],
  );
  t.deepEqual(
    log.map(([name, state]) => [name, state]),
    [
      ['exec', 'refused-builtin'],
      ['accountStatus', 'refused-builtin'],
      ['t', 'refused-duplicate'],
      ['t', 'refused-duplicate'],
    ],
  );
  t.is(log[0][2], textOf.toolNameBuiltIn('exec'));
  t.is(log[2][2], textOf.toolNameDuplicate('t'));
  t.is(set.refused.length, 4);
  // On ports without the adapter tool, accountStatus is offered.
  log.length = 0;
  const other = toolSetFor(
    portsWithout,
    toolTable,
    {},
    harden({ toolSources: [source] }),
  );
  t.true(other.byName.has('accountStatus'));
  t.deepEqual(
    log.map(([name]) => name),
    ['exec', 't', 't'],
  );
  t.deepEqual(
    [...builtInToolNames(portsWith)],
    [
      'echo',
      'exec',
      'list',
      'lookup',
      'store',
      'remove',
      'describeCapability',
      'readSources',
      'adopt',
      'adoptTool',
      'runCommand',
      'inspectShell',
      'accountStatus',
    ],
  );
  // The runtime reaches the source, with the round's built-in names.
  /** @type {any} */
  let seen;
  /** @type {any} */
  let names;
  const runtime = harden({
    toolSources: [
      (
        /** @type {any} */ _p,
        /** @type {any} */ _s,
        /** @type {any} */ r,
        /** @type {Set<string>} */ b,
      ) => {
        seen = r;
        names = b;
        return [];
      },
    ],
  });
  toolSetFor(portsWithout, toolTable, {}, runtime);
  t.is(seen, runtime);
  t.deepEqual([...names], [...builtInToolNames(portsWithout)]);
});

test('toolSetFor keeps at most maxToolsPerRound descriptions', t => {
  const many = () =>
    harden(Array.from({ length: 200 }, (_, i) => dynamic(`g${i}`)));
  const set = toolSetFor(
    harden({ tools: [] }),
    toolTable,
    {},
    harden({ toolSources: [many] }),
  );
  t.is(set.descriptions.length, limits.maxToolsPerRound);
});
