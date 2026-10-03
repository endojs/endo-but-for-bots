// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import fc from 'fast-check';

import {
  acquireAdmission,
  errorCategory,
  makeTerminationRace,
} from '../src/turn-guard.js';

test('a race before termination yields the awaited value', async t => {
  const { untilTerminated } = makeTerminationRace();
  t.is(await untilTerminated(Promise.resolve('value')), 'value');
  t.is(await untilTerminated('plain'), 'plain');
});

test('termination ends a wait that never settles', async t => {
  const { signalTerminated, untilTerminated } = makeTerminationRace();
  const waiting = untilTerminated(new Promise(() => {}));
  signalTerminated();
  await t.throwsAsync(waiting, { message: 'turn terminated' });
});

test('after termination an already-settled value does not win the race', async t => {
  const { signalTerminated, untilTerminated } = makeTerminationRace();
  signalTerminated();
  await null;
  /** @type {unknown[]} */
  const cleaned = [];
  await t.throwsAsync(
    untilTerminated(Promise.resolve('eager'), value => cleaned.push(value)),
    { message: 'turn terminated' },
  );
  await null;
  await null;
  t.deepEqual(cleaned, ['eager']);
});

test('a value that arrives after termination goes to lateCleanup', async t => {
  const { signalTerminated, untilTerminated } = makeTerminationRace();
  /** @type {(value: string) => void} */
  let deliver = () => {};
  /** @type {string[]} */
  const cleaned = [];
  const waiting = untilTerminated(
    new Promise(resolve => {
      deliver = resolve;
    }),
    value => cleaned.push(value),
  );
  signalTerminated();
  await t.throwsAsync(waiting, { message: 'turn terminated' });
  deliver('late grant');
  await null;
  await null;
  t.deepEqual(cleaned, ['late grant']);
});

test('errorCategory prefers a well-formed code, then a class name', t => {
  t.is(
    errorCategory(Object.assign(Error('secret'), { code: 'ENOENT' })),
    'ENOENT',
  );
  t.is(errorCategory(TypeError('secret')), 'TypeError');
  t.is(
    errorCategory(Object.assign(Error('secret'), { code: 'not a code' })),
    'Error',
  );
  t.is(errorCategory({ code: `E${'X'.repeat(64)}`, name: 'Named' }), 'Named');
  t.is(errorCategory({ name: 'has spaces' }), 'error');
  t.is(errorCategory('secret'), 'string');
  t.is(errorCategory(null), 'object');
  t.is(errorCategory(undefined), 'undefined');
});

test('errorCategory survives a throwing getter', t => {
  const hostile = {
    get code() {
      throw Error('secret');
    },
  };
  t.is(errorCategory(hostile), 'error');
});

const errorLike = fc.record(
  {
    code: fc.oneof(fc.string(), fc.constantFrom('ENOENT', 'E2BIG', 'EPIPE')),
    name: fc.oneof(fc.string(), fc.constantFrom('Error', 'TypeError')),
    message: fc.string(),
  },
  { requiredKeys: [] },
);

test('errorCategory never depends on the message', t => {
  fc.assert(
    fc.property(errorLike, fc.string(), (error, otherMessage) => {
      t.is(
        errorCategory(error),
        errorCategory({ ...error, message: otherMessage }),
      );
    }),
  );
});

test('errorCategory names only a vetted code, a vetted name, or a kind', t => {
  fc.assert(
    fc.property(errorLike, error => {
      const category = errorCategory(error);
      const vettedCode =
        category === error.code && /^[A-Z][A-Z0-9_]{0,63}$/.test(category);
      const vettedName =
        category === error.name && /^[A-Za-z]{1,64}$/.test(category);
      t.true(vettedCode || vettedName || category === 'error');
    }),
  );
});

test('acquireAdmission passes a well-formed grant through', async t => {
  const grant = harden({
    type: /** @type {const} */ ('granted'),
    environment: harden({ ANTHROPIC_AUTH_TOKEN: 'credential' }),
    release: Far('release', () => {}),
  });
  const source = /** @type {any} */ (
    Far('source', { acquire: async () => grant })
  );
  t.is(await acquireAdmission(source), grant);
});

test('acquireAdmission reports a malformed grant without its contents', async t => {
  const source = /** @type {any} */ (
    Far('source', {
      acquire: async () => harden({ type: 'granted', token: 'credential' }),
    })
  );
  t.deepEqual(await acquireAdmission(source), {
    type: 'failed',
    detail: 'malformed admission',
  });
});

test('acquireAdmission reports a rejection without its message', async t => {
  const source = /** @type {any} */ (
    Far('source', {
      acquire: async () => {
        throw Error('credential');
      },
    })
  );
  t.deepEqual(await acquireAdmission(source), {
    type: 'failed',
    detail: 'acquire rejected',
  });
});
