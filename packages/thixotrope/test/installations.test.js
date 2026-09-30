// @ts-check
import { E, Far } from '@endo/far';
import test from '@endo/ses-ava/test.js';

import { makeInstallations } from '../src/control/installations.js';

/**
 * A stand-in for the vat facade the host attaches: its evaluator runs the
 * factory call the registry issues, guest to guest.
 * @param {(source: string, endowments: any) => unknown} evaluate
 */
const makeVat = evaluate =>
  Far('Worker', {
    getEvaluator: () => Far('Evaluator', { evaluate }),
  });

test('an application is started once and captures only its named powers', async t => {
  let started = 0n;
  const root = Far('Application', {});
  const capability = Far('Granted', {});
  const inventory = new Map([
    ['selected', capability],
    ['other', Far('Other', {})],
  ]);
  const installations = makeInstallations(inventory);
  const reserved = installations.prepare('app', 'application', 'hash', 'key', [
    ['service', 'selected'],
    ['alias', 'selected'],
  ]);
  t.deepEqual(reserved, {
    allocationKey: 'key',
    workerId: undefined,
    complete: false,
  });
  // A retry with the same identity, grants in another order, finds it.
  t.deepEqual(
    installations.prepare('app', 'application', 'hash', 'unused key', [
      ['alias', 'selected'],
      ['service', 'selected'],
    ]),
    reserved,
  );
  installations.attach(
    'app',
    'hash',
    'worker',
    makeVat((source, { powers }) => {
      started += 1n;
      t.is(
        source,
        '(globalThis.installed ??= installation.namespace.make(powers))',
      );
      t.deepEqual(Object.keys(powers), ['alias', 'service']);
      t.is(powers.service, capability);
      return root;
    }),
  );
  const first = E(installations).start('app', 'hash');
  const second = E(installations).start('app', 'hash');
  t.is(await first, root);
  t.is(await second, root);
  t.is(started, 1n);
  t.is(inventory.get('app'), root);
  t.like((await E(installations).list())[0], {
    name: 'app',
    kind: 'application',
    status: 'ready',
    grants: [
      ['alias', 'selected'],
      ['service', 'selected'],
    ],
  });
  t.deepEqual(installations.lookup('app'), {
    kind: 'application',
    workerId: 'worker',
    complete: true,
  });
  t.throws(
    () =>
      installations.prepare('app', 'application', 'different', 'key', [
        ['service', 'selected'],
      ]),
    { message: /different installation/ },
  );
  t.throws(
    () =>
      installations.prepare('app', 'application', 'hash', 'key', [
        ['service', 'other'],
      ]),
    { message: /different installation/ },
  );
  t.throws(() => installations.prepare('app', 'native', 'hash', 'key'), {
    message: /different installation/,
  });
  t.true(installations.remove('app'));
  t.false(inventory.has('app'), 'its own value goes with the name');
  t.false(installations.remove('app'));
  t.is(installations.lookup('app'), undefined);
});

test('grants are checked when the name is reserved, before any vat exists', t => {
  /** @type {Map<string, unknown>} */
  const inventory = new Map([['data', 'x'.repeat(10)]]);
  const installations = makeInstallations(inventory);
  t.throws(
    () =>
      installations.prepare('app', 'application', 'hash', 'key', [
        ['power', 'absent'],
      ]),
    { message: /Unknown inventory grant/ },
  );
  t.throws(
    () =>
      installations.prepare('app', 'application', 'hash', 'key', [
        ['power', 'data'],
      ]),
    { message: /remotable capabilities/ },
  );
  t.throws(
    () =>
      installations.prepare('app', 'application', 'hash', 'key', [
        ['power', 'data'],
        ['power', 'data'],
      ]),
    { message: /Duplicate power name/ },
  );
  t.is(installations.lookup('app'), undefined, 'nothing was reserved');
  inventory.set('taken', Far('Taken', {}));
  t.throws(() => installations.prepare('taken', 'application', 'hash', 'key'), {
    message: /already occupied/,
  });
  t.throws(() => installations.prepare('', 'application', 'hash', 'key'), {
    message: /inventory name/,
  });
  const kind = /** @type {any} */ ('other');
  t.throws(() => installations.prepare('app', kind, 'hash', 'key'), {
    message: /application.*native/s,
  });
});

test('a failed factory stays inspectable and is not run again', async t => {
  let started = 0n;
  const inventory = new Map();
  const installations = makeInstallations(inventory);
  installations.prepare('bad', 'application', 'hash', 'key');
  installations.attach(
    'bad',
    'hash',
    'worker',
    makeVat(() => {
      started += 1n;
      throw Error('factory failed');
    }),
  );
  await t.throwsAsync(() => E(installations).start('bad', 'hash'), {
    message: /factory failed/,
  });
  await t.throwsAsync(() => E(installations).start('bad', 'hash'), {
    message: /factory failed/,
  });
  t.is(started, 1n);
  t.like((await E(installations).list())[0], {
    status: 'failed',
    error: 'Error: factory failed',
  });
  t.false(inventory.has('bad'));
  t.deepEqual(installations.lookup('bad'), {
    kind: 'application',
    workerId: 'worker',
    complete: false,
  });
  // Removal frees the name; a corrected package is a new installation.
  t.true(installations.remove('bad'));
  installations.prepare('bad', 'application', 'fixed', 'key');
  t.like((await E(installations).list())[0], {
    digest: 'fixed',
    status: 'pending',
  });
});

test('a native installation finishes with its registration and honours later edits', t => {
  const inventory = new Map();
  const installations = makeInstallations(inventory);
  const registration = Far('Registration', {});
  t.deepEqual(installations.prepare('name', 'native', 'digest', 'key'), {
    allocationKey: 'key',
    workerId: undefined,
    complete: false,
  });
  t.throws(() => installations.start('name', 'digest'), {
    message: /Only an application/,
  });
  t.throws(() => installations.finish('name', 'digest', registration), {
    message: /not been allocated/,
  });
  installations.attach('name', 'digest', 'worker', Far('Worker', {}));
  t.throws(
    () => installations.attach('name', 'digest', 'other', Far('W', {})),
    {
      message: /allocation changed/,
    },
  );
  inventory.set('name', 'concurrent edit');
  t.throws(() => installations.finish('name', 'digest', registration), {
    message: /became occupied/,
  });
  t.is(inventory.get('name'), 'concurrent edit');
  inventory.delete('name');
  installations.finish('name', 'digest', registration);
  inventory.set('name', 'later edit');
  installations.finish('name', 'digest', registration);
  t.true(
    installations.prepare('name', 'native', 'digest', 'unused key').complete,
  );
  t.is(inventory.get('name'), 'later edit');
  installations.fail('name', 'digest', 'too late');
  t.like(installations.list()[0], { status: 'ready', error: undefined });
  // Removal never takes a value the user put there.
  t.true(installations.remove('name'));
  t.is(inventory.get('name'), 'later edit');
  inventory.delete('name');
  installations.prepare('name', 'native', 'digest', 'key');
  installations.attach('name', 'digest', 'worker', Far('Worker', {}));
  installations.fail('name', 'digest', 'factory failed');
  t.like(installations.list()[0], {
    status: 'failed',
    error: 'factory failed',
  });
  t.throws(() => installations.finish('name', 'other', registration), {
    message: /different installation/,
  });
});
