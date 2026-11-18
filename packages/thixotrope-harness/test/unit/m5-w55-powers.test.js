// @ts-check
// M5 W5.5 (designs/m5-interfaces.md 2.4.3, 2.4.4, H-10): the session's
// ExecPowersSource (guest/session/powers-source.js), the inspecting object
// tools and the inspector part (guest/session/tools/inspection.js) over an
// in-memory label map and a fake exec vat, and the M5 fixture provisioning
// step (a no-op without options.m5Fixtures). No supervisor, no timers.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import { textOf as textOfM5 } from '../../guest/lib/interfaces-m5.js';
import { limits } from '../../guest/lib/limits.js';
import { limitsM5 } from '../../guest/lib/limits-m5.js';
import { makeLabels } from '../../guest/session/labels.js';
import { m5Parts, makeRuntime } from '../../guest/session/m5-parts.js';
import { makePowersSource } from '../../guest/session/powers-source.js';
import {
  inspectionToolEntries,
  notCapabilityText,
} from '../../guest/session/tools/inspection.js';
import { objectToolEntries } from '../../guest/session/tools/objects.js';
import { toolTable } from '../../guest/session/tool-table.js';
/* eslint-enable import/no-relative-packages */
import {
  m5FixtureStep,
  provisionSteps,
} from '../../scripts/provision-steps.js';
import { m5FixtureName, m5FixtureSource } from '../fixtures/m5-objects.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

/** @param {number} [n] */
const drain = (n = 6) =>
  n === 0
    ? Promise.resolve()
    : new Promise(resolve => setImmediate(resolve)).then(() => drain(n - 1));

test('ExecPowersSource answers from the label map: lookup, list, store, remove', t => {
  const notes = Far('notes', { read: () => 'n' });
  const labels = makeLabels({
    seeds: [{ label: 'notes', value: notes, source: 'endowment' }],
  });
  const source = makePowersSource(labels);
  t.is(source.lookup('notes'), notes);
  t.is(source.lookup('nope'), undefined);
  source.store('x', harden({ json: '{"a":[1,2]}' }));
  t.deepEqual(source.lookup('x'), { json: '{"a":[1,2]}' });
  const made = Far('made', {});
  source.store('y', made);
  t.is(source.lookup('y'), made);
  t.like(labels.get('y'), { kind: 'object', source: 'stored' });
  t.deepEqual(source.list(), ['notes', 'x', 'y']);
  t.true(source.remove('x'));
  t.false(source.remove('x'));
  t.deepEqual(source.list(), ['notes', 'y']);
});

test('ExecPowersSource refusals are the label map texts', t => {
  const labels = makeLabels();
  const source = makePowersSource(labels);
  source.store('x', harden({ json: '1' }));
  t.throws(() => source.store('x', harden({ json: '2' })), {
    message: textOfM5.labelTaken('x'),
  });
  t.throws(() => source.store('user', harden({ json: '2' })), {
    message: textOfM5.reservedLabel('user'),
  });
  t.throws(() => source.store('a/b', harden({ json: '2' })), {
    message: textOfM5.reservedLabel('a/b'),
  });
  // A non-ASCII value: under the guard's unit bound, over the byte bound.
  const big = 'é'.repeat(limitsM5.labelValueBytes / 2 + 1);
  t.throws(() => source.store('big', harden({ json: big })), {
    message: textOfM5.valueTooLarge(
      Buffer.byteLength(big),
      limitsM5.labelValueBytes,
    ),
  });
  // The guard: a record that is neither an object nor `{ json }`.
  t.throws(() => source.store('z', /** @type {any} */ (harden({ j: '1' }))));
  t.deepEqual(source.list(), ['x']);
});

test('the runtime registers the powers and inspector parts', t => {
  const labels = makeLabels();
  const runtime = makeRuntime({ labels, services: {}, config: {} });
  t.deepEqual(
    m5Parts.map(p => p.name).filter(n => n === 'powers' || n === 'inspector'),
    ['powers', 'inspector'],
  );
  // The powers part is the exo itself (tools/exec.js sends it as is).
  t.is(typeof runtime.powers.lookup, 'function');
  t.is(typeof runtime.inspector.lookup, 'function');
  const names = toolTable.map(e => e.name);
  t.true(
    names.indexOf('describeCapability') > names.indexOf('remove') &&
      names.indexOf('readSources') === names.indexOf('describeCapability') + 1,
  );
});

/** A session's exec vat whose `inspect` answers the test controls. */
const setup = () => {
  /** @type {{ request: any, kit: any }[]} */
  const inspects = [];
  const scope = Far('ExecScope', {
    /** @param {any} request */
    inspect: request => {
      const kit = makePromiseKit();
      inspects.push({ request, kit });
      return kit.promise;
    },
    run: () => new Promise(() => {}),
    abandon: () => undefined,
  });
  const execVat = Far('ExecHandle', {
    scope: () => harden({ scope, deadlineMs: 4000 }),
    retire: () => undefined,
  });
  /** @type {any[]} */
  const endpointLog = [];
  const endpoint = Far('Endpoint', {
    /** @param {any} r */
    armDeadline: r => endpointLog.push(['arm', r.opId]),
    /** @param {any} r */
    disarm: r => endpointLog.push(['disarm', r.opId]),
  });
  const notes = Far('notes', { read: () => 'n' });
  const labels = makeLabels({
    seeds: [{ label: 'notes', value: notes, source: 'endowment' }],
  });
  labels.bindJson('stored', '{"v":1}');
  const services = harden({ execVat });
  const runtime = makeRuntime({ labels, services, config: {} });
  const writers = Far('BlobWriters', {});
  const ports = harden({ writers, timer: Far('Timer', {}) });
  const context = harden({
    turn: 1,
    turnId: 't1',
    services,
    endpoint,
    runtime,
  });
  return { inspects, endpointLog, notes, labels, ports, context, services };
};

/** @param {string} name */
const entryOf = name =>
  /** @type {any} */ (
    [...objectToolEntries, ...inspectionToolEntries].find(e => e.name === name)
  );

test('describeCapability sends one inspector describe; readSources the raw items with the deadline', async t => {
  const s = setup();
  const describe = entryOf('describeCapability');
  t.true(describe.available(s.ports, s.services));
  t.false(describe.available(harden({}), s.services));
  t.false(describe.available(s.ports, harden({})));
  const answer = describe.execute(
    { opId: 'op1', args: '{"petName":"notes","method":"read"}', turnId: 't1' },
    s.ports,
    s.context,
  );
  await drain();
  t.is(s.inspects.length, 1);
  t.like(s.inspects[0].request, { op: 'describe', method: 'read' });
  t.is(s.inspects[0].request.target, s.notes);
  s.inspects[0].kit.resolve(harden({ status: 'ok', text: '{"methods":[]}' }));
  t.deepEqual(await answer, { status: 'ok', text: '{"methods":[]}' });
  t.deepEqual(s.endpointLog, [], 'describe arms no deadline');

  const items = '[{"path":["README.md"],"search":"x"}]';
  const read = entryOf('readSources').execute(
    { opId: 'op2', args: `{"petName":"notes","items":${items}}`, turnId: 't1' },
    s.ports,
    s.context,
  );
  await drain();
  t.is(s.inspects.length, 2);
  t.like(s.inspects[1].request, { op: 'readSources', args: items });
  t.deepEqual(s.endpointLog, [['arm', 'op2']]);
  s.inspects[1].kit.resolve(harden({ status: 'ok', text: '{"results":[]}' }));
  t.deepEqual(await read, { status: 'ok', text: '{"results":[]}' });
  t.deepEqual(s.endpointLog, [
    ['arm', 'op2'],
    ['disarm', 'op2'],
  ]);
});

test('the inspecting tools refuse before any call: unknown label, stored value, unknown key, staged arguments', async t => {
  const s = setup();
  const describe = entryOf('describeCapability');
  /** @param {any} args */
  const call = args =>
    describe.execute({ opId: 'o', args, turnId: 't1' }, s.ports, s.context);
  t.deepEqual(await call('{"petName":"nope"}'), {
    status: 'failed',
    text: textOfM5.unknownLabel('nope'),
  });
  t.deepEqual(await call('{"petName":"stored"}'), {
    status: 'failed',
    text: notCapabilityText('stored'),
  });
  t.deepEqual(await call('{"petName":"notes","x":1}'), {
    status: 'failed',
    text: textOf.unexpectedArgument('x', 'describeCapability', [
      'petName',
      'method',
    ]),
  });
  const staged = harden({
    blob: Far('Blob', {}),
    preview: '',
    bytes: limits.inlineBytes + 1,
  });
  const refused = await entryOf('readSources').execute(
    { opId: 'o', args: staged, turnId: 't1' },
    s.ports,
    s.context,
  );
  t.is(refused.status, 'failed');
  t.is(s.inspects.length, 0);
});

test('lookup of an object: one inspector methods call, then the cached names', async t => {
  const s = setup();
  const lookup = entryOf('lookup');
  const first = lookup.execute(
    { opId: 'l1', args: '{"petName":"notes"}', turnId: 't1' },
    s.ports,
    s.context,
  );
  await drain();
  t.is(s.inspects.length, 1);
  t.like(s.inspects[0].request, { op: 'methods' });
  s.inspects[0].kit.resolve(
    harden({ status: 'ok', methods: ['read', 'help'] }),
  );
  const line = '[remote capability] callable methods: ["read","help"]';
  t.deepEqual(await first, { status: 'ok', text: line });
  const second = await lookup.execute(
    { opId: 'l2', args: '{"petName":"notes"}', turnId: 't1' },
    s.ports,
    s.context,
  );
  t.deepEqual(second, { status: 'ok', text: line });
  t.is(s.inspects.length, 1, 'no second call');
  // A failed inspection is passed through and caches nothing.
  s.labels.bindObject('calc', Far('calc', {}), 'stored');
  const failedLookup = lookup.execute(
    { opId: 'l3', args: '{"petName":"calc"}', turnId: 't1' },
    s.ports,
    s.context,
  );
  await drain();
  s.inspects[1].kit.resolve(harden({ status: 'failed', text: 'gone' }));
  t.deepEqual(await failedLookup, { status: 'failed', text: 'gone' });
  t.is(
    s.labels.methodsOf(/** @type {any} */ (s.labels.get('calc'))),
    undefined,
  );
});

test('the m5 fixture step is a no-op without options.m5Fixtures', async t => {
  t.is(provisionSteps.at(-1), m5FixtureStep);
  /** @type {any[]} */
  const calls = [];
  const client = {
    /** @param {any[]} args */
    call: async (...args) => {
      calls.push(args);
      return undefined;
    },
  };
  const options = { sessionEntry: 'x' };
  t.deepEqual(await m5FixtureStep.run({ client, options }), { skipped: true });
  t.deepEqual(calls, []);
});

test('the m5 fixture step evaluates the fixtures once and skips when kept', async t => {
  /** @type {Map<string, any>} */
  const inventory = new Map();
  /** @type {string[]} */
  const evaluated = [];
  const client = {
    /**
     * @param {string} method
     * @param {string} arg
     */
    call: async (method, arg) => {
      if (method === 'lookup') return inventory.get(arg);
      evaluated.push(arg);
      inventory.set(m5FixtureName, {});
      return true;
    },
  };
  const options = {
    sessionEntry: 'x',
    m5Fixtures: { name: m5FixtureName, source: m5FixtureSource },
  };
  t.like(await m5FixtureStep.run({ client, options }), { skipped: false });
  t.is(evaluated.length, 1);
  t.true(evaluated[0].startsWith(`(inventory.set("${m5FixtureName}", ((`));
  t.like(await m5FixtureStep.run({ client, options }), { skipped: true });
  t.is(evaluated.length, 1);
});
